require('dotenv').config({ path: '.env.supabase' });
if (!process.env.SUPABASE_URL) require('dotenv').config({ path: '.dev.vars' });
if (!process.env.SUPABASE_URL) require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { getDataSourceUrl } = require('./source-config.cjs');

const API_BASE = getDataSourceUrl();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_KEY) {
  console.error('❌ Error: SUPABASE_SERVICE_ROLE_KEY wajib ada di .env.supabase');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const isDryRun = process.argv.includes('--dry-run');

const VALID_SHAPES = [
  'tk', 'kb', 'sps', 'tpa', 'paudq', 'sd', 'smp', 'sma', 'smk', 'slb',
  'skb', 'pkbm', 'kursus', 'ra', 'mi', 'mts', 'ma',
  'smak', 'smptk', 'smtk', 'sdtk', 'spk-kb', 'spk-sd', 'spk-sma', 'spk-smp', 'spk-tk',
  'spm-ula', 'spm-ulya', 'spm-wustha', 'taman-seminari', 'pdf-ulya', 'pdf-wustha',
  'mak', 'mula-dhammasekha', 'nava-dhammasekha', 'uttama-dhammasekha', 'pondok-pesantren',
  'smag-k'
];

async function getApiCount(kodeWilayah, bentuk) {
  try {
    const res = await fetch(
      `${API_BASE}/${kodeWilayah}?limit=1&offset=0&bentukPendidikan=${bentuk}`
    );
    if (!res.ok) return -1;
    const j = await res.json();
    return j.meta?.total ?? -1;
  } catch (e) {
    return -1;
  }
}

async function fetchAllApiNpsnsForShape(kodeWilayah, bentuk, totalApi) {
  const limit = 20; // API Kementerian maksimal mengembalikan 20 data per request
  const offsets = [];
  for (let o = 0; o < totalApi; o += limit) {
    offsets.push(o);
  }

  const npsnSet = new Set();
  const concurrency = 20;
  let curr = 0;

  async function worker() {
    while (curr < offsets.length) {
      const offset = offsets[curr++];
      try {
        const res = await fetch(
          `${API_BASE}/${kodeWilayah}?limit=${limit}&offset=${offset}&bentukPendidikan=${bentuk}`
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
  console.log(`\n🚀 MEMULAI PEMERIKSAAN SEKOLAH NON-AKTIF JAWA BARAT (${isDryRun ? 'MODE SIMULASI / DRY RUN' : 'MODE EKSEKUSI HAPUS'})`);

  const { count: totalDb } = await sb
    .from('sekolah')
    .select('*', { count: 'exact', head: true })
    .eq('nama_provinsi', 'PROV. JAWA BARAT');

  console.log(`Total data Jawa Barat di DB saat ini: ${totalDb} sekolah.`);

  // Cek per bentuk pendidikan secara cepat
  console.log('Membandingkan jumlah per bentuk pendidikan antara DB dan API Pusat...');
  const shapeTasks = VALID_SHAPES.map(async (bKey) => {
    const apiTotal = await getApiCount('020000', bKey);
    if (apiTotal < 0) return null;

    const { count: dbCount } = await sb
      .from('sekolah')
      .select('*', { count: 'exact', head: true })
      .eq('nama_provinsi', 'PROV. JAWA BARAT')
      .ilike('bentuk_pendidikan', bKey.replace(/-/g, ' '));

    return {
      bKey,
      apiTotal,
      dbCount: dbCount || 0,
      diff: (dbCount || 0) - apiTotal
    };
  });

  const shapeResults = (await Promise.all(shapeTasks)).filter(Boolean);

  const surplusShapes = shapeResults.filter(s => s.diff > 0);
  console.log(`Ditemukan ${surplusShapes.length} bentuk pendidikan dengan kelebihan data di DB:`);
  for (const s of surplusShapes) {
    console.log(`  - [${s.bKey.toUpperCase()}]: DB=${s.dbCount}, API=${s.apiTotal} (Kelebihan: +${s.diff})`);
  }

  const staleSchools = [];

  for (const s of surplusShapes) {
    console.log(`\nMemeriksa detail NPSN bentuk [${s.bKey.toUpperCase()}] (Target: ${s.diff} sekolah)...`);
    let from = 0;
    const dbSchools = [];
    while (true) {
      const { data, error } = await sb
        .from('sekolah')
        .select('npsn, nama, bentuk_pendidikan, nama_kabupaten, nama_kecamatan, alamat_jalan')
        .eq('nama_provinsi', 'PROV. JAWA BARAT')
        .ilike('bentuk_pendidikan', s.bKey.replace(/-/g, ' '))
        .range(from, from + 999);
      if (error || !data || data.length === 0) break;
      dbSchools.push(...data);
      if (data.length < 1000) break;
      from += 1000;
    }

    const apiNpsnSet = await fetchAllApiNpsnsForShape('020000', s.bKey, s.apiTotal);
    const staleInShape = dbSchools.filter((sc) => !apiNpsnSet.has(sc.npsn));

    console.log(`   Ditemukan ${staleInShape.length} sekolah tidak aktif di API:`);
    for (const sc of staleInShape) {
      console.log(`     - [${sc.npsn}] ${sc.nama} (${sc.nama_kabupaten}, ${sc.nama_kecamatan})`);
    }
    staleSchools.push(...staleInShape);
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Total sekolah non-aktif terdeteksi di Jawa Barat: ${staleSchools.length}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  if (!isDryRun && staleSchools.length > 0) {
    console.log(`Menghapus ${staleSchools.length} sekolah non-aktif dari database Supabase...`);
    const npsnsToDelete = staleSchools.map(s => s.npsn);
    for (let i = 0; i < npsnsToDelete.length; i += 100) {
      const chunk = npsnsToDelete.slice(i, i + 100);
      const { error: delErr } = await sb.from('sekolah').delete().in('npsn', chunk);
      if (delErr) {
        console.error(`Gagal menghapus chunk ${i}:`, delErr.message);
      } else {
        console.log(`Berhasil menghapus chunk ${i + 1} - ${i + chunk.length}`);
      }
    }

    // Hitung ulang total DB aktual
    const { count: finalCount } = await sb
      .from('sekolah')
      .select('*', { count: 'exact', head: true })
      .eq('nama_provinsi', 'PROV. JAWA BARAT');

    console.log(`✅ Total DB Jawa Barat sekarang: ${finalCount}`);

    // Update provinsi_sync_status
    await sb
      .from('provinsi_sync_status')
      .upsert({
        nama_provinsi: 'JAWA BARAT',
        terakhir_sukses: new Date().toISOString(),
        total_db: finalCount,
      });

    // Update status_sinkronisasi
    const { count: grandCount } = await sb.from('sekolah').select('*', { count: 'exact', head: true });
    if (grandCount && grandCount > 0) {
      await sb.from('status_sinkronisasi').update({
        total_sekolah: grandCount,
        updated_at: new Date().toISOString()
      }).in('id', [1, 2]);
    }

    // Update cache_data 'perbandingan'
    try {
      const { data: cacheRow } = await sb.from('cache_data').select('value').eq('key', 'perbandingan').single();
      if (cacheRow?.value) {
        const list = JSON.parse(cacheRow.value);
        const item = list.find((x) => x.kode === '020000' || x.nama === 'JAWA BARAT');
        if (item) {
          item.total_db = finalCount;
          item.raw_selisih = (item.total_api || 0) - finalCount;
          item.selisih = Math.max(0, item.raw_selisih);
          item.extra_in_db = Math.max(0, finalCount - (item.total_api || 0));
          item.is_sinkron_walau_selisih = (item.selisih === 0 && item.extra_in_db === 0);
          item.terakhir_sukses = new Date().toISOString();

          await sb.from('cache_data').upsert({
            key: 'perbandingan',
            value: JSON.stringify(list),
            updated_at: new Date().toISOString()
          });
          console.log(`✅ Cache data perbandingan berhasil diperbarui untuk Jawa Barat.`);
        }
      }
    } catch (e) {
      console.warn('Gagal update cache perbandingan:', e.message);
    }
  }
})();
