import { getApiMeta } from '../lib/sync-meta.js';
import { getStatusSinkronisasiPublik } from '../lib/status-sinkronisasi.js';
import { formatDbRowResponse } from '../lib/sekolah-schema.js';
import { getDb } from '../lib/db.js';
import { listSekolah, searchSekolah, listSekolahFiltered, countSekolahFiltered } from '../lib/sekolah-db.js';

const DEVELOPER = 'Syamsul Bahri';

export async function onRequest(context) {
  const { searchParams } = new URL(context.request.url);
  const keyword = searchParams.get('keyword');
  const provinsi = searchParams.get('provinsi');
  const bentuk = searchParams.get('bentuk');

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
    const db = getDb(context.env);
    const [sinkron, apiMeta] = await Promise.all([
      getStatusSinkronisasiPublik(db),
      getApiMeta(db),
    ]);
    const totalSekolah = sinkron.total_sekolah ?? apiMeta.totalSekolah;
    
    let rows;
    let totalResult;

    if (provinsi || bentuk) {
      const filters = {
        keyword: keyword?.trim() || undefined,
        provinsi: provinsi?.trim() || undefined,
        bentuk: bentuk?.trim() || undefined
      };
      rows = await listSekolahFiltered(db, filters, limit, offset);
      totalResult = keyword ? null : await countSekolahFiltered(db, filters);
    } else {
      rows = keyword
        ? await searchSekolah(db, keyword.trim(), limit, offset)
        : await listSekolah(db, limit, offset);
      totalResult = keyword ? null : totalSekolah;
    }

    const formattedResults = rows.map((row) => formatDbRowResponse(row));

    const metadata = {
      limit_ditampilkan: limit,
      offset_saat_ini: offset,
      waktu_update_data_terakhir: sinkron.waktu_selesai_terakhir,
      waktu_update_data_terakhir_iso: sinkron.waktu_selesai_terakhir_iso,
      developer: DEVELOPER,
    };

    if (provinsi || bentuk) {
      if (keyword) {
        metadata.total_data_tersedia = null;
        metadata.catatan_total = 'Total hasil pencarian tidak dihitung agar kuota baca database tetap hemat.';
        metadata.has_more = formattedResults.length === limit;
      } else {
        metadata.total_data_tersedia = totalResult;
        metadata.has_more = offset + formattedResults.length < totalResult;
      }
    } else if (keyword) {
      metadata.total_data_tersedia = null;
      metadata.catatan_total =
        'Total hasil pencarian tidak dihitung agar kuota baca database tetap hemat.';
      metadata.has_more = formattedResults.length === limit;
    } else {
      metadata.total_data_tersedia = totalSekolah;
      metadata.has_more =
        totalSekolah != null
          ? offset + formattedResults.length < totalSekolah
          : formattedResults.length === limit;
    }

    const responsePayload = {
      status: 'success',
      source: 'API Sekolah Mandiri',
      developer: DEVELOPER,
      metadata,
      data: formattedResults,
    };

    if (keyword && formattedResults.length === 0) {
      responsePayload.message = 'Hmm, NPSN tidak ditemukan! 🕵️‍♂️ Pastikan angka NPSN yang dimasukkan sudah benar, atau sekolah tersebut mungkin belum terdaftar di semesta kami.';
    }

    return new Response(JSON.stringify(responsePayload), { headers });
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
