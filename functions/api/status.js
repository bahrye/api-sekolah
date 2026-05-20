import { buildSyncStatusReport } from '../lib/sync-status.js';
import { getSql } from '../lib/neon.js';

const jsonHeaders = {
  'Content-Type': 'application/json;charset=UTF-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=300, stale-while-revalidate=600',
};

/** Metadata dari Neon (sync_meta + count sekolah) */
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
    const sql = getSql(context.env);
    const report = await buildSyncStatusReport(sql);
    const body = {
      status: 'success',
      total_data_tersedia: report.database.total_sekolah,
      waktu_update_data_terakhir: report.database.waktu_update_terakhir,
      waktu_update_data_terakhir_iso: report.database.waktu_update_terakhir_iso,
      jadwal_sync: 'Setiap Senin, 01:00 WITA (Cloudflare Cron)',
      sinkronisasi: report.sinkronisasi,
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
