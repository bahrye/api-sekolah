import { getDb } from '../lib/db.js';
import { getRekapSekolah } from '../lib/sekolah-db.js';

export async function onRequest(context) {
  const headers = {
    'Content-Type': 'application/json;charset=UTF-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  };

  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  try {
    const db = getDb(context.env);
    const rows = await getRekapSekolah(db);
    
    const provSet = new Set();
    const jenjangSet = new Set();
    const mapData = {};

    for (const row of rows) {
      const p = row.nama_provinsi;
      const j = row.bentuk_pendidikan;
      const total = row.total;

      provSet.add(p);
      jenjangSet.add(j);

      if (!mapData[p]) mapData[p] = {};
      mapData[p][j] = total;
    }

    return new Response(
      JSON.stringify({
        status: 'success',
        metadata: {
          provinsi: Array.from(provSet).sort(),
          jenjang: Array.from(jenjangSet).sort(),
        },
        data: mapData,
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
