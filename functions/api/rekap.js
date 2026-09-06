import { getDb, isSupabase } from '../lib/db.js';
import { getRekapSekolah } from '../lib/sekolah-db.js';
import rekapPrecomputed from '../../data_rekap.json';

export async function onRequest(context) {
  const headers = {
    'Content-Type': 'application/json;charset=UTF-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
  };

  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  try {
    if (isSupabase(context.env)) {
      return new Response(JSON.stringify(rekapPrecomputed), { headers });
    }

    const db = getDb(context.env);
    const rows = await getRekapSekolah(db);
    
    const provSet = new Set();
    const negaraSet = new Set();
    const jenjangSet = new Set();
    const mapIndonesia = {};
    const mapLuarNegeri = {};

    for (const row of rows) {
      const p = row.nama_provinsi;
      const n = row.nama_negara;
      const j = row.bentuk_pendidikan;
      const total = row.total;

      jenjangSet.add(j);

      if (p === 'LUAR NEGERI') {
        if (n) {
          negaraSet.add(n);
          if (!mapLuarNegeri[n]) mapLuarNegeri[n] = {};
          mapLuarNegeri[n][j] = total;
        }
      } else {
        provSet.add(p);
        if (!mapIndonesia[p]) mapIndonesia[p] = {};
        mapIndonesia[p][j] = total;
      }
    }

    return new Response(
      JSON.stringify({
        status: 'success',
        metadata: {
          provinsi: Array.from(provSet).sort(),
          negara: Array.from(negaraSet).sort(),
          jenjang: Array.from(jenjangSet).sort(),
        },
        data: {
          indonesia: mapIndonesia,
          luar_negeri: mapLuarNegeri,
        },
      }),
      { headers }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        status: 'error',
        message: 'Gagal memproses rekap data: ' + error.message,
      }),
      { headers, status: 500 }
    );
  }
}
