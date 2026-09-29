require('dotenv').config({ path: '.env.supabase' });
if (!process.env.SUPABASE_URL) require('dotenv').config({ path: '.dev.vars' });
if (!process.env.SUPABASE_URL) require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const { getDataSourceUrl } = require('./source-config.cjs');

const API_BASE = getDataSourceUrl();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL atau SUPABASE_KEY belum dikonfigurasi.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const PROVINCES = {
  '010000': 'DKI JAKARTA', '020000': 'JAWA BARAT', '030000': 'JAWA TENGAH', '040000': 'DI YOGYAKARTA',
  '050000': 'JAWA TIMUR', '060000': 'ACEH', '070000': 'SUMATERA UTARA', '080000': 'SUMATERA BARAT',
  '090000': 'RIAU', '100000': 'JAMBI', '110000': 'SUMATERA SELATAN', '120000': 'LAMPUNG',
  '130000': 'KALIMANTAN BARAT', '140000': 'KALIMANTAN TENGAH', '150000': 'KALIMANTAN SELATAN',
  '160000': 'KALIMANTAN TIMUR', '170000': 'SULAWESI UTARA', '180000': 'SULAWESI TENGAH',
  '190000': 'SULAWESI SELATAN', '200000': 'SULAWESI TENGGARA', '210000': 'MALUKU', '220000': 'BALI',
  '230000': 'NUSA TENGGARA BARAT', '240000': 'NUSA TENGGARA TIMUR', '250000': 'PAPUA', '260000': 'BENGKULU',
  '270000': 'MALUKU UTARA', '280000': 'BANTEN', '290000': 'KEPULAUAN BANGKA BELITUNG', '300000': 'GORONTALO',
  '310000': 'KEPULAUAN RIAU', '320000': 'PAPUA BARAT', '330000': 'SULAWESI BARAT', '340000': 'KALIMANTAN UTARA',
  '350000': 'LUAR NEGERI', '360000': 'PAPUA TENGAH', '370000': 'PAPUA SELATAN', '380000': 'PAPUA PEGUNUNGAN',
  '390000': 'PAPUA BARAT DAYA'
};

const cleanName = (name) => {
  if (!name) return '';
  return name.replace(/[^A-Z0-9]/gi, '').toUpperCase().replace(/^PROVINSI|^PROV/, '');
};

async function refreshCache() {
  console.log('🔄 Memperbarui cache perbandingan data...');
  
  // 1. Ambil status rows dari Supabase
  const { data: statusRows } = await supabase.from('provinsi_sync_status').select('*');
  const statusMap = new Map((statusRows || []).map(s => [cleanName(s.nama_provinsi), s]));

  // Helper: fetch dengan retry 3x dan timeout 15 detik per percobaan
  async function fetchApiTotal(kode, retries = 3, timeoutMs = 15000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(`${API_BASE}/${kode}?limit=1&offset=0`, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const total = json.meta ? json.meta.total : null;
        if (total !== null && total >= 0) return total;
        throw new Error('meta.total tidak ditemukan dalam response');
      } catch (e) {
        if (attempt === retries) {
          console.warn(`  ⚠️  [${kode}] ${PROVINCES[kode]}: gagal setelah ${retries}x percobaan — ${e.message}`);
          return 0;
        }
        // Backoff: 500ms, 1000ms, ...
        await new Promise(r => setTimeout(r, attempt * 500));
      }
    }
    return 0;
  }

  // 2. Query data untuk 38 provinsi (paralel, masing-masing dengan retry)
  console.log(`  Fetching ${Object.keys(PROVINCES).length} provinsi dari API Pusat...`);
  const apiPromises = Object.keys(PROVINCES).map(async (kode) => {
    const total_api = await fetchApiTotal(kode);
    return { kode, nama: PROVINCES[kode], total_api };
  });
  const apiData = await Promise.all(apiPromises);

  const validCount = apiData.filter(d => d.total_api > 0).length;
  console.log(`  ℹ️  API Pusat: ${validCount}/${apiData.length} provinsi berhasil diambil datanya.`);

  // 3. Ambil count riil dari v_rekap_provinsi
  const dbTotalsMap = new Map();
  try {
    const { data: vRekap } = await supabase.from('v_rekap_provinsi').select('*');
    if (vRekap && vRekap.length > 0) {
      vRekap.forEach(r => {
        if (r.nama_provinsi) {
          dbTotalsMap.set(cleanName(r.nama_provinsi), r.total_sekolah || 0);
        }
      });
    }
  } catch (e) {}

  // Ambil rincian duplikasi dari npsn_ganda_detail untuk membedakan Paginasi vs Ganda Riil
  const dupDetailMap = new Map();
  try {
    const { data: dupRows } = await supabase
      .from('npsn_ganda_detail')
      .select('nama_provinsi, sekolah_detail');
    (dupRows || []).forEach(r => {
      const cName = cleanName(r.nama_provinsi);
      if (!dupDetailMap.has(cName)) {
        dupDetailMap.set(cName, { pagination: 0, real: 0 });
      }
      let list = [];
      try {
        list = typeof r.sekolah_detail === 'string' ? JSON.parse(r.sekolah_detail) : (r.sekolah_detail || []);
      } catch (e) {}

      let isIdentical = true;
      if (list && list.length > 1) {
        const first = list[0];
        for (let i = 1; i < list.length; i++) {
          const cur = list[i];
          if (
            cur.nama !== first.nama ||
            cur.bentuk !== first.bentuk ||
            cur.status !== first.status ||
            cur.kecamatan !== first.kecamatan ||
            cur.kabupaten !== first.kabupaten ||
            (cur.alamat || '') !== (first.alamat || '')
          ) {
            isIdentical = false;
            break;
          }
        }
      } else {
        isIdentical = false;
      }

      const stat = dupDetailMap.get(cName);
      if (isIdentical) stat.pagination++;
      else stat.real++;
    });
  } catch (e) {}

  const compared = apiData.map((item) => {
    const cName = cleanName(item.nama);
    const syncInfo = statusMap.get(cName);

    let dbTotal = 0;
    if (dbTotalsMap.has(cName)) {
      dbTotal = dbTotalsMap.get(cName);
    } else if (syncInfo && syncInfo.total_db > 0) {
      dbTotal = syncInfo.total_db;
    }

    const raw_selisih = item.total_api - dbTotal;
    let selisih = raw_selisih;
    if (raw_selisih > 0) {
      const effDuplicates = (syncInfo?.api_duplicates || 0);
      selisih = Math.max(0, raw_selisih - effDuplicates);
    }
    const is_sinkron_walau_selisih = (selisih === 0);
    const extra_in_db = Math.max(0, dbTotal - item.total_api);

    const dupStat = dupDetailMap.get(cName) || { pagination: 0, real: 0 };
    const totalDup = syncInfo?.api_duplicates || 0;
    let api_pagination_duplicates = dupStat.pagination;
    let api_real_duplicates = dupStat.real;

    if (totalDup > 0 && api_pagination_duplicates === 0 && api_real_duplicates === 0) {
      api_pagination_duplicates = totalDup;
    }

    return {
      kode: item.kode,
      nama: item.nama,
      total_api: item.total_api,
      total_db: dbTotal,
      selisih: selisih,
      raw_selisih: raw_selisih,
      extra_in_db: extra_in_db,
      is_sinkron_walau_selisih: is_sinkron_walau_selisih,
      terakhir_sukses: syncInfo?.terakhir_sukses || null,
      api_duplicates: syncInfo?.api_duplicates || 0,
      api_pagination_duplicates: api_pagination_duplicates,
      api_real_duplicates: api_real_duplicates,
      api_empty_npsn: syncInfo?.api_empty_npsn || 0,
      api_unrecognized_shapes: syncInfo?.api_unrecognized_shapes || 0,
    };
  });

  // Validasi sebelum simpan ke cache_data
  // Jangan overwrite cache lama jika mayoritas total_api = 0 (API Pusat bermasalah)
  const totalProvinsi = compared.length;
  const partial_api_failure = validCount < Math.ceil(totalProvinsi * 0.5);

  if (partial_api_failure) {
    console.warn(`⚠️  Hanya ${validCount}/${totalProvinsi} provinsi berhasil dari API Pusat.`);
    console.warn('   Cache lama TIDAK diperbarui untuk menghindari data 0 yang salah tampil di UI.');
  } else {
    const { error } = await supabase.from('cache_data').upsert({
      key: 'perbandingan',
      value: JSON.stringify(compared),
      updated_at: new Date().toISOString()
    });

    if (error) {
      console.error('Error saat menyimpan ke cache_data:', error);
    } else {
      console.log('✅ Berhasil memperbarui cache_data perbandingan.');
    }

    // Sinkronkan juga total_db ke provinsi_sync_status
    for (const item of compared) {
      if (item.total_db > 0) {
        await supabase.from('provinsi_sync_status').update({ total_db: item.total_db }).eq('nama_provinsi', item.nama);
      }
    }
  }

  // Tampilkan preview 6 provinsi
  const focus = compared.filter(c => [
    'JAWA BARAT', 'JAWA TENGAH', 'JAWA TIMUR',
    'KALIMANTAN SELATAN', 'KALIMANTAN UTARA', 'KEPULAUAN BANGKA BELITUNG', 'BALI'
  ].includes(c.nama));
  console.table(focus.map(f => ({
    Provinsi: f.nama,
    API: f.total_api,
    DB: f.total_db,
    RawSelisih: f.raw_selisih,
    Selisih: f.selisih,
    ExtraDB: f.extra_in_db,
    Status: f.selisih === 0 ? 'SINKRON ✅' : (f.extra_in_db > 0 ? 'LEBIH DI DB ⚠️' : 'BELUM SINKRON ⚠️')
  })));
}

refreshCache();
