import { getStatusSinkronisasiPublik } from '../lib/status-sinkronisasi.js';
import { getDb } from '../lib/db.js';

const jsonHeaders = {
  'Content-Type': 'application/json;charset=UTF-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=1800, s-maxage=3600, stale-while-revalidate=7200',
};

/** GET /api/status — metadata publik (tanpa detail proses sync) */
export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers: jsonHeaders });
  }

  if (context.request.method !== 'GET' && context.request.method !== 'HEAD') {
    return new Response(JSON.stringify({ status: 'error', message: 'Method not allowed' }), {
      status: 405,
      headers: jsonHeaders,
    });
  }

  try {
    const db = getDb(context.env);
    const pub = await getStatusSinkronisasiPublik(db);
    const body = {
      status: 'success',
      developer: 'Syamsul Bahri',
      total_data_tersedia: pub.total_sekolah,
      waktu_update_data_terakhir: pub.waktu_selesai_terakhir,
      waktu_update_data_terakhir_iso: pub.waktu_selesai_terakhir_iso,
      jadwal_sync: 'Pembaruan berkala dari portal resmi (GitHub Actions)',
    };

    if (context.request.method === 'HEAD') {
      return new Response(null, { headers: jsonHeaders });
    }

    return new Response(JSON.stringify(body), { headers: jsonHeaders });
  } catch (error) {
    return new Response(JSON.stringify({ status: 'error', message: error.message }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
