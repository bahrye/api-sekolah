import { getStatusSinkronisasiPublik } from '../lib/status-sinkronisasi.js';
import { formatDbRowResponse } from '../lib/sekolah-schema.js';
import { getDb, isSupabase, getSupabase } from '../lib/db.js';
import { listSekolah, searchSekolah, listSekolahFiltered } from '../lib/sekolah-db.js';
import {
  listSekolahSupabase,
  searchSekolahSupabase,
  listSekolahFilteredSupabase,
  getStatusSinkronisasiSupabase,
} from '../lib/sekolah-supabase.js';

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
    'Cache-Control': 'public, max-age=1800, s-maxage=86400, stale-while-revalidate=86400',
  };

  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  try {
    let rows;
    let sinkron;

    if (isSupabase(context.env)) {
      const supabase = getSupabase(context.env);
      sinkron = await getStatusSinkronisasiSupabase(supabase);

      if (provinsi || bentuk) {
        const filters = {
          keyword: keyword?.trim() || undefined,
          provinsi: provinsi?.trim() || undefined,
          bentuk: bentuk?.trim() || undefined,
        };
        rows = await listSekolahFilteredSupabase(supabase, filters, limit, offset);
      } else {
        rows = keyword
          ? await searchSekolahSupabase(supabase, keyword.trim(), limit, offset)
          : await listSekolahSupabase(supabase, limit, offset);
      }
    } else {
      const db = getDb(context.env);
      sinkron = await getStatusSinkronisasiPublik(db);

      if (provinsi || bentuk) {
        const filters = {
          keyword: keyword?.trim() || undefined,
          provinsi: provinsi?.trim() || undefined,
          bentuk: bentuk?.trim() || undefined,
        };
        rows = await listSekolahFiltered(db, filters, limit, offset);
      } else {
        rows = keyword
          ? await searchSekolah(db, keyword.trim(), limit, offset)
          : await listSekolah(db, limit, offset);
      }
    }

    const totalSekolah = sinkron.total_sekolah;
    const formattedResults = rows.map((row) => formatDbRowResponse(row));

    const metadata = {
      limit_ditampilkan: limit,
      offset_saat_ini: offset,
      waktu_update_data_terakhir: sinkron.waktu_selesai_terakhir,
      waktu_update_data_terakhir_iso: sinkron.waktu_selesai_terakhir_iso,
      developer: DEVELOPER,
    };

    if (provinsi || bentuk || keyword) {
      metadata.total_data_tersedia = null;
      metadata.catatan_total = 'Total hasil pencarian/filter tidak dihitung dinamis agar kuota baca database tetap hemat.';
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
