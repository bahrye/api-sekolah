import { getSupabase } from '../lib/db.js';
import { getDataSourceUrl } from '../lib/source-config.js';

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

export async function onRequestGet(context) {
  try {
    const supabase = getSupabase(context.env);
    const url = new URL(context.request.url);
    const isForce = url.searchParams.get('refresh') === 'true' || url.searchParams.get('force') === 'true';

    let synced_today = 0;
    try {
      const nowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
      const wibDateStr = nowWib.toISOString().split('T')[0];
      const startOfWibDayUtc = new Date(`${wibDateStr}T00:00:00+07:00`).toISOString();

      const { data: logs } = await supabase
        .from('log_aktivitas_provinsi')
        .select('total_baru, total_diperbarui, total_tidak_berubah')
        .gte('waktu_selesai', startOfWibDayUtc);

      synced_today = (logs || []).reduce(
        (acc, l) => acc + (l.total_baru || 0) + (l.total_diperbarui || 0) + (l.total_tidak_berubah || 0),
        0
      );
    } catch (e) {}

    // Cek cache_data
    try {
      const { data: cacheRow } = await supabase
        .from('cache_data')
        .select('value, updated_at')
        .eq('key', 'perbandingan')
        .single();

      if (cacheRow?.value) {
        const cacheAgeMs = cacheRow.updated_at
          ? Date.now() - new Date(cacheRow.updated_at).getTime()
          : Infinity;
        if (!isForce && cacheAgeMs < 15 * 60 * 1000) {
          return new Response(
            JSON.stringify({
              success: true,
              data: JSON.parse(cacheRow.value),
              synced_today,
              from_cache: true,
            }),
            {
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
              },
            }
          );
        }
      }
    } catch (e) {}

    // Ambil status per provinsi dari Supabase
    const { data: statusRows } = await supabase
      .from('provinsi_sync_status')
      .select('*');

    const statusMap = new Map((statusRows || []).map((s) => [cleanName(s.nama_provinsi), s]));

    // Query data pusat
    const apiBase = getDataSourceUrl(context.env);
    const promises = Object.keys(PROVINCES).map(async (kode) => {
      try {
        const res = await fetch(
          `${apiBase}/${kode}?limit=1&offset=0`
        );
        const json = await res.json();
        return { kode, nama: PROVINCES[kode], total_api: json.meta ? json.meta.total : 0 };
      } catch (e) {
        return { kode, nama: PROVINCES[kode], total_api: 0 };
      }
    });

    const apiData = await Promise.all(promises);

    // Ambil data rekap dari precomputed atau Supabase
    let rekapIndonesia = {};
    let rekapLuarNegeri = {};
    try {
      const rekapModule = await import('../../data_rekap.json');
      rekapIndonesia = rekapModule.default?.data?.indonesia || {};
      rekapLuarNegeri = rekapModule.default?.data?.luar_negeri || {};
    } catch (e) {}

    // Ambil data hitungan riil dari View Supabase v_rekap_provinsi jika tersedia
    let dbTotalsMap = new Map();
    try {
      const { data: vRekap } = await supabase
        .from('v_rekap_provinsi')
        .select('*');
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
      } else if (item.nama === 'LUAR NEGERI') {
        dbTotal = Object.values(rekapLuarNegeri).reduce((total, negaraObj) => {
          return total + Object.values(negaraObj).reduce((sum, count) => sum + count, 0);
        }, 0);
      } else {
        const fullKey = 'PROV. ' + item.nama;
        const provObj = rekapIndonesia[fullKey] || rekapIndonesia[item.nama] || {};
        dbTotal = Object.values(provObj).reduce((sum, count) => sum + count, 0);
      }

      const raw_selisih = item.total_api - dbTotal;
      const unrecShapesInDb = (raw_selisih <= 0) ? 0 : Math.min(raw_selisih, syncInfo?.api_unrecognized_shapes || 0);
      let selisih = raw_selisih;
      if (raw_selisih > 0) {
        const effDuplicates = (syncInfo?.api_duplicates || 0);
        selisih = Math.max(0, raw_selisih - effDuplicates - unrecShapesInDb);
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
        api_unrecognized_shapes: unrecShapesInDb,
      };
    });

    // Simpan ke cache_data
    try {
      await supabase.from('cache_data').upsert({
        key: 'perbandingan',
        value: JSON.stringify(compared),
        updated_at: new Date().toISOString(),
      });
    } catch (e) {}

    return new Response(
      JSON.stringify({
        success: true,
        data: compared,
        synced_today,
        from_cache: false,
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
