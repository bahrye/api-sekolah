import { getApiMeta } from '../lib/sync-meta.js';
import { getRowFpStatsForReport } from '../lib/backfill-row-fp.js';
import { getSql } from '../lib/neon.js';

const jsonHeaders = {
  'Content-Type': 'application/json;charset=UTF-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=3, stale-while-revalidate=5',
};

/** GET /api/row-fp-status — baca cache sync_meta saja (tanpa secret, tanpa COUNT). */
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
    const meta = await getApiMeta(sql);
    const row_fp = await getRowFpStatsForReport(sql, meta.totalSekolah);

    if (context.request.method === 'HEAD') {
      return new Response(null, { headers: jsonHeaders });
    }

    return new Response(
      JSON.stringify({
        status: 'success',
        row_fp,
        petunjuk: row_fp.measured
          ? null
          : 'Belum diukur — buka halaman backfill dan klik «Ukur ulang» (butuh secret).',
      }),
      { headers: jsonHeaders }
    );
  } catch (error) {
    return new Response(JSON.stringify({ status: 'error', message: error.message }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
