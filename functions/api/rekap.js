import rekapPrecomputed from '../../data_rekap.json';
import { getSupabase } from '../lib/db.js';

export async function onRequest(context) {
  const headers = {
    'Content-Type': 'application/json;charset=UTF-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  };

  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  try {
    const supabase = getSupabase(context.env);
    let result = null;

    // 1. Ambil data rekap realtime dari cache_data Supabase jika tersedia
    try {
      const { data: cacheRow } = await supabase
        .from('cache_data')
        .select('value')
        .eq('key', 'rekap_data')
        .single();
      if (cacheRow?.value) {
        result = typeof cacheRow.value === 'string' ? JSON.parse(cacheRow.value) : cacheRow.value;
      }
    } catch (e) {}

    if (!result) {
      result = JSON.parse(JSON.stringify(rekapPrecomputed));
    }

    // 2. Ambil data Luar Negeri dinamis dari Supabase jika tersedia
    try {
      const { data: lnRows, error } = await supabase
        .from('sekolah')
        .select('nama_kabupaten, bentuk_pendidikan')
        .eq('nama_provinsi', 'LUAR NEGERI');

      if (!error && lnRows && lnRows.length > 0) {
        const lnMap = {};
        const negaraSet = new Set();

        for (const r of lnRows) {
          const country = (r.nama_kabupaten || 'LAINNYA').trim().toUpperCase();
          const bentuk = (r.bentuk_pendidikan || 'LAINNYA').trim().toUpperCase();

          negaraSet.add(country);
          if (!lnMap[country]) lnMap[country] = {};
          lnMap[country][bentuk] = (lnMap[country][bentuk] || 0) + 1;
        }

        result.metadata.negara = Array.from(negaraSet).sort();
        result.data.luar_negeri = lnMap;
      }
    } catch (dbErr) {
      // Fallback transparan ke data precomputed jika Supabase tidak dapat diakses
    }

    return new Response(JSON.stringify(result), { headers });
  } catch (error) {
    return new Response(
      JSON.stringify(rekapPrecomputed),
      { headers }
    );
  }
}

