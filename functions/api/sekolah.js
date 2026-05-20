import { getApiMeta, formatSyncTimeWib } from '../lib/sync-meta.js';
import { formatNeonRowResponse } from '../lib/sekolah-schema.js';
import { getSql } from '../lib/neon.js';
import { listSekolah, searchSekolah } from '../lib/sekolah-pg.js';

export async function onRequest(context) {
  const { searchParams } = new URL(context.request.url);
  const keyword = searchParams.get('keyword');

  const DEFAULT_LIMIT = 20;
  const MAX_LIMIT = 50;

  let limit = parseInt(searchParams.get('limit'), 10);
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);

  let offset = parseInt(searchParams.get('offset'), 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  const headers = {
    'Content-Type': 'application/json;charset=UTF-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  };

  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  try {
    const sql = getSql(context.env);
    const apiMeta = await getApiMeta(sql);
    const rows = keyword
      ? await searchSekolah(sql, keyword.trim(), limit, offset)
      : await listSekolah(sql, limit, offset);

    const formattedResults = rows.map((row) => formatNeonRowResponse(row));

    const metadata = {
      limit_ditampilkan: limit,
      offset_saat_ini: offset,
      waktu_update_data_terakhir: apiMeta.lastSyncIso ? formatSyncTimeWib(apiMeta.lastSyncIso) : null,
      waktu_update_data_terakhir_iso: apiMeta.lastSyncIso,
    };

    if (keyword) {
      metadata.total_data_tersedia = null;
      metadata.catatan_total =
        'Total hasil pencarian tidak dihitung agar kuota baca database tetap hemat.';
      metadata.has_more = formattedResults.length === limit;
    } else {
      metadata.total_data_tersedia = apiMeta.totalSekolah;
      metadata.has_more =
        apiMeta.totalSekolah != null
          ? offset + formattedResults.length < apiMeta.totalSekolah
          : formattedResults.length === limit;
    }

    return new Response(
      JSON.stringify({
        status: 'success',
        source: 'API Sekolah Mandiri',
        metadata,
        data: formattedResults,
      }),
      { headers }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        status: 'error',
        message: 'Gagal memproses database: ' + error.message,
      }),
      { headers, status: 500 }
    );
  }
}
