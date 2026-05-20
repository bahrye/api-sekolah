import { getApiMeta, formatSyncTimeWib } from '../lib/sync-meta.js';
import { SELECT_COLS, formatRowResponse } from '../lib/sekolah-schema.js';

export async function onRequest(context) {
  const { searchParams } = new URL(context.request.url);
  const keyword = searchParams.get('keyword');

  const DEFAULT_LIMIT = 20;
  /** Sementara 250 untuk migrasi ke Neon — kembalikan ke 50 setelah migrasi selesai. */
  const MAX_LIMIT = 250;

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
    const apiMeta = await getApiMeta(context.env.DB);
    let results;

    if (keyword) {
      const stmt = context.env.DB.prepare(
        `SELECT ${SELECT_COLS} FROM sekolah WHERE NPSN LIKE ? OR Nama LIKE ? LIMIT ? OFFSET ?`
      ).bind(`%${keyword}%`, `%${keyword}%`, limit, offset);
      const { results: searchResults } = await stmt.all();
      results = searchResults;
    } else {
      const stmt = context.env.DB.prepare(
        `SELECT ${SELECT_COLS} FROM sekolah LIMIT ? OFFSET ?`
      ).bind(limit, offset);
      const { results: allResults } = await stmt.all();
      results = allResults;
    }

    const formattedResults = results.map((row) => formatRowResponse(row));

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
