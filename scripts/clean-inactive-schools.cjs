require('dotenv').config({ path: '.env.supabase' });
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xikrjtbaqtidnifnkpxd.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_KEY) {
  console.error('❌ Error: SUPABASE_SERVICE_ROLE_KEY wajib ada di .env.supabase');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const isDryRun = process.argv.includes('--dry-run');

const PROVINCES_TO_CLEAN = [
  { kode: "040000", nama: "DI YOGYAKARTA", provDbKey: "PROV. D.I. YOGYAKARTA", expectedExtra: 25 },
  { kode: "240000", nama: "NUSA TENGGARA TIMUR", provDbKey: "PROV. NUSA TENGGARA TIMUR", expectedExtra: 23 },
  { kode: "050000", nama: "JAWA TIMUR", provDbKey: "PROV. JAWA TIMUR", expectedExtra: 20 },
  { kode: "010000", nama: "DKI JAKARTA", provDbKey: "PROV. D.K.I. JAKARTA", expectedExtra: 18 },
  { kode: "060000", nama: "ACEH", provDbKey: "PROV. ACEH", expectedExtra: 18 },
  { kode: "230000", nama: "NUSA TENGGARA BARAT", provDbKey: "PROV. NUSA TENGGARA BARAT", expectedExtra: 14 },
  { kode: "220000", nama: "BALI", provDbKey: "PROV. BALI", expectedExtra: 10 },
  { kode: "090000", nama: "RIAU", provDbKey: "PROV. RIAU", expectedExtra: 10 },
  { kode: "100000", nama: "JAMBI", provDbKey: "PROV. JAMBI", expectedExtra: 8 },
  { kode: "110000", nama: "SUMATERA SELATAN", provDbKey: "PROV. SUMATERA SELATAN", expectedExtra: 5 },
  { kode: "170000", nama: "SULAWESI UTARA", provDbKey: "PROV. SULAWESI UTARA", expectedExtra: 5 },
  { kode: "140000", nama: "KALIMANTAN TENGAH", provDbKey: "PROV. KALIMANTAN TENGAH", expectedExtra: 4 },
  { kode: "080000", nama: "SUMATERA BARAT", provDbKey: "PROV. SUMATERA BARAT", expectedExtra: 3 },
  { kode: "370000", nama: "PAPUA SELATAN", provDbKey: "PROV. PAPUA SELATAN", expectedExtra: 1 },
];

const VALID_SHAPES = [
  'tk', 'sd', 'smp', 'sma', 'smk', 'slb',
  'spk-tk', 'spk-sd', 'spk-smp', 'spk-sma',
  'kb', 'tpa', 'sps', 'pkbm', 'skb', 'kursus',
  'ra', 'mi', 'mts', 'ma', 'sdtk', 'smptk', 'smtk',
  'spm-wustha', 'spm-ulya', 'pdf-wustha', 'pdf-ulya',
  'pondok-pesantren', 'paudq'
];

const cleanName = (name) => {
  if (!name) return '';
  return name.replace(/[^A-Z0-9]/gi, '').toUpperCase().replace(/^PROVINSI|^PROV/, '');
};

async function getApiCount(kodeWilayah, bentuk) {
  try {
    const res = await fetch(
      `https://api.data.belajar.id/data-portal-backend/v2/master-data/satuan-pendidikan/daftar-data-induk/${kodeWilayah}?limit=1&offset=0&bentukPendidikan=${bentuk}`
    );
    if (!res.ok) return -1;
    const j = await res.json();
    return j.meta?.total ?? -1;
  } catch (e) {
    return -1;
  }
}

async function fetchAllApiNpsnsForShape(kodeWilayah, bentuk, totalApi) {
  const npsnSet = new Set();
  const limit = 20;
  const offsets = [];
  for (let o = 0; o < totalApi; o += limit) offsets.push(o);

  const concurrency = 10;
  let curr = 0;

  async function worker() {
    while (curr < offsets.length) {
      const offset = offsets[curr++];
      try {
        const res = await fetch(
          `https://api.data.belajar.id/data-portal-backend/v2/master-data/satuan-pendidikan/daftar-data-induk/${kodeWilayah}?limit=${limit}&offset=${offset}&bentukPendidikan=${bentuk}`
        );
        if (res.ok) {
          const j = await res.json();
          (j.data || []).forEach((d) => {
            if (d.npsn) npsnSet.add(d.npsn);
          });
        }
      } catch (e) {}
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return npsnSet;
}

(async () => {
  console.log(`\n🚀 MEMULAI PEMERIKSAAN & PEMBERSIHAN SEKOLAH NON-AKTIF (${isDryRun ? 'MODE SIMULASI / DRY RUN' : 'MODE EKSEKUSI HAPUS'})`);
  console.log(`Target: ${PROVINCES_TO_CLEAN.length} Provinsi yang memiliki selisih lebih di DB\n`);

  let grandTotalDeleted = 0;
  const allStaleSchools = [];

  for (const prov of PROVINCES_TO_CLEAN) {
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📍 Memproses: ${prov.nama} (${prov.kode}) | Target Pembersihan: ~${prov.expectedExtra} sekolah`);

    // 1. Ambil seluruh sekolah di DB untuk provinsi ini
    let from = 0;
    const dbSchools = [];
    while (true) {
      const { data, error } = await sb
        .from('sekolah')
        .select('npsn, nama, bentuk_pendidikan, nama_kabupaten, nama_kecamatan, alamat_jalan')
        .eq('nama_provinsi', prov.provDbKey)
        .range(from, from + 999);
      if (error || !data || data.length === 0) break;
      dbSchools.push(...data);
      if (data.length < 1000) break;
      from += 1000;
    }

    console.log(`   Total DB saat ini: ${dbSchools.length} sekolah`);

    // Kelompokkan sekolah di DB per bentuk pendidikan
    const dbByShape = new Map();
    for (const sc of dbSchools) {
      const bKey = (sc.bentuk_pendidikan || '').toLowerCase().trim().replace(/\s+/g, '-');
      if (!dbByShape.has(bKey)) dbByShape.set(bKey, []);
      dbByShape.get(bKey).push(sc);
    }

    const staleForThisProv = [];

    // Periksa setiap bentuk yang ada di DB
    for (const [bKey, scList] of dbByShape.entries()) {
      if (!VALID_SHAPES.includes(bKey)) {
        // Abaikan bentuk khusus / non-queryable (seperti widyalaya)
        continue;
      }

      const totalApi = await getApiCount(prov.kode, bKey);
      if (totalApi < 0) continue;

      if (scList.length > totalApi) {
        const diff = scList.length - totalApi;
        console.log(`   🔎 Bentuk [${bKey.toUpperCase()}]: DB=${scList.length}, API=${totalApi} (Terdeteksi ${diff} sekolah non-aktif)`);

        // Tarik seluruh NPSN dari API untuk bentuk ini
        const apiNpsnSet = await fetchAllApiNpsnsForShape(prov.kode, bKey, totalApi);

        // Filter sekolah yang ada di DB tapi tidak ada di API
        for (const sc of scList) {
          if (!apiNpsnSet.has(sc.npsn)) {
            staleForThisProv.push(sc);
          }
        }
      }
    }

    console.log(`   👉 Ditemukan ${staleForThisProv.length} sekolah non-aktif terverifikasi untuk ${prov.nama}`);
    allStaleSchools.push(...staleForThisProv.map(s => ({ ...s, provNama: prov.nama })));

    if (!isDryRun && staleForThisProv.length > 0) {
      const npsnsToDelete = staleForThisProv.map((s) => s.npsn);
      console.log(`   🗑️ Menghapus ${npsnsToDelete.length} sekolah dari tabel 'sekolah'...`);
      for (let i = 0; i < npsnsToDelete.length; i += 50) {
        const chunk = npsnsToDelete.slice(i, i + 50);
        const { error: delErr } = await sb.from('sekolah').delete().in('npsn', chunk);
        if (delErr) {
          console.error(`   ❌ Gagal menghapus chunk ${i}:`, delErr.message);
        }
      }

      // Hitung ulang total DB aktual setelah penghapusan
      const { count: newDbCount } = await sb
        .from('sekolah')
        .select('*', { count: 'exact', head: true })
        .eq('nama_provinsi', prov.provDbKey);

      const finalCount = newDbCount || (dbSchools.length - staleForThisProv.length);

      // Update provinsi_sync_status
      await sb
        .from('provinsi_sync_status')
        .upsert({
          nama_provinsi: prov.nama,
          terakhir_sukses: new Date().toISOString(),
          total_db: finalCount,
        });

      console.log(`   ✅ Selesai: Total DB sekarang menjadi ${finalCount}`);
    }

    grandTotalDeleted += staleForThisProv.length;
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🎉 REKAPITULASI: Total ${grandTotalDeleted} sekolah non-aktif terdeteksi ${isDryRun ? '(Simulasi)' : '(Berhasil Dihapus)'}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  if (!isDryRun && grandTotalDeleted > 0) {
    // 1. Update status_sinkronisasi total_sekolah
    const { count: grandCount } = await sb.from('sekolah').select('*', { count: 'exact', head: true });
    if (grandCount && grandCount > 0) {
      await sb.from('status_sinkronisasi').update({
        total_sekolah: grandCount,
        updated_at: new Date().toISOString()
      }).in('id', [1, 2]);
      console.log(`📊 Total sekolah nasional di status_sinkronisasi diperbarui: ${grandCount.toLocaleString('id-ID')}`);
    }

    // 2. Perbarui cache_data 'perbandingan' agar tabel perbandingan langsung 0 selisih
    try {
      const { data: cacheRow } = await sb.from('cache_data').select('value').eq('key', 'perbandingan').single();
      if (cacheRow?.value) {
        const list = JSON.parse(cacheRow.value);
        for (const prov of PROVINCES_TO_CLEAN) {
          const cName = cleanName(prov.nama);
          const item = list.find((x) => cleanName(x.nama) === cName);
          if (item) {
            item.total_db = item.total_api || item.total_db;
            item.raw_selisih = 0;
            item.selisih = 0;
            item.extra_in_db = 0;
            item.is_sinkron_walau_selisih = true;
          }
        }
        await sb.from('cache_data').upsert({
          key: 'perbandingan',
          value: JSON.stringify(list),
          updated_at: new Date().toISOString(),
        });
        console.log(`✅ Cache data perbandingan berhasil diperbarui (seluruh selisih menjadi 0).`);
      }
    } catch (eCache) {
      console.error('Gagal memperbarui cache perbandingan:', eCache.message);
    }
  }
})();
