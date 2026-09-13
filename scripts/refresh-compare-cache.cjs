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

  // 2. Query data untuk 38 provinsi
  const apiPromises = Object.keys(PROVINCES).map(async (kode) => {
    try {
      const res = await fetch(`${API_BASE}/${kode}?limit=1&offset=0`);
      const json = await res.json();
      return { kode, nama: PROVINCES[kode], total_api: json.meta ? json.meta.total : 0 };
    } catch (e) {
      return { kode, nama: PROVINCES[kode], total_api: 0 };
    }
  });
  const apiData = await Promise.all(apiPromises);

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
      const effUnrecognized = Math.min(raw_selisih, syncInfo?.api_unrecognized_shapes || 0);
      selisih = Math.max(0, raw_selisih - effDuplicates - effUnrecognized);
    }
    const is_sinkron_walau_selisih = (selisih === 0);
    const extra_in_db = Math.max(0, dbTotal - item.total_api);

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
      api_empty_npsn: syncInfo?.api_empty_npsn || 0,
      api_unrecognized_shapes: syncInfo?.api_unrecognized_shapes || 0,
    };
  });

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
