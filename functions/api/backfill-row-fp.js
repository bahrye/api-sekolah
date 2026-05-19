import { assertSyncAuthorized } from '../lib/sync-auth.js';
import { getApiMeta } from '../lib/sync-meta.js';
import {
  backfillRowFpBatch,
  countNullRowFp,
  chainBackfillRequest,
  buildBackfillContinueUrl,
  recordRowFpStats,
  getRowFpStatsForReport,
  BACKFILL_BATCH_SIZE,
} from '../lib/backfill-row-fp.js';

const jsonHeaders = {
  'Content-Type': 'application/json;charset=UTF-8',
  'Access-Control-Allow-Origin': '*',
};

/**
 * GET /api/backfill-row-fp?secret=...
 * - stats=1 → hanya hitung baris tanpa row_fp (untuk pantau progress)
 * - default → proses satu batch, lanjut otomatis di background (waitUntil)
 * - wait=1 → proses satu batch, tunggu hasil (tanpa chain)
 */
export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers: jsonHeaders });
  }

  if (context.request.method !== 'GET' && context.request.method !== 'POST') {
    return new Response(JSON.stringify({ status: 'error', message: 'Method not allowed' }), {
      status: 405,
      headers: jsonHeaders,
    });
  }

  const requestUrl = new URL(context.request.url);
  const auth = assertSyncAuthorized(context.request, requestUrl, context.env);
  if (!auth.ok) {
    return auth.response;
  }

  const secret =
    requestUrl.searchParams.get('secret') ||
    context.request.headers.get('X-Sync-Secret') ||
    context.env.SYNC_SECRET;

  const statsOnly = requestUrl.searchParams.get('stats') === '1';
  const noChain = requestUrl.searchParams.get('no_chain') === '1';
  const batchParam = parseInt(requestUrl.searchParams.get('batch') || '', 10);
  const batchSize = Number.isFinite(batchParam)
    ? Math.max(1, Math.min(500, batchParam))
    : BACKFILL_BATCH_SIZE;

  try {
    const meta = await getApiMeta(context.env.DB);
    const remainingBefore = await countNullRowFp(context.env.DB);
    await recordRowFpStats(context.env.DB, remainingBefore, {
      active: statsOnly ? false : remainingBefore > 0 && !noChain,
    });

    if (statsOnly) {
      const row_fp = await getRowFpStatsForReport(context.env.DB, meta.totalSekolah);
      return new Response(
        JSON.stringify({
          status: 'success',
          row_fp,
          row_fp_null: remainingBefore,
          selesai: remainingBefore === 0,
          petunjuk:
            remainingBefore > 0
              ? 'Panggil tanpa stats=1 untuk mulai backfill (butuh secret yang sama).'
              : 'Semua baris sudah punya row_fp.',
        }),
        { headers: jsonHeaders }
      );
    }

    if (remainingBefore === 0) {
      await recordRowFpStats(context.env.DB, 0, { active: false });
      const row_fp = await getRowFpStatsForReport(context.env.DB, meta.totalSekolah);
      return new Response(
        JSON.stringify({
          status: 'success',
          message: 'Tidak ada baris dengan row_fp kosong.',
          batch: { processed: 0, updated: 0 },
          row_fp,
          row_fp_null: 0,
          selesai: true,
        }),
        { headers: jsonHeaders }
      );
    }

    await recordRowFpStats(context.env.DB, remainingBefore, { active: true });
    const batch = await backfillRowFpBatch(context.env.DB, batchSize);
    const remainingAfter = await countNullRowFp(context.env.DB);
    const done = batch.done || remainingAfter === 0;
    await recordRowFpStats(context.env.DB, remainingAfter, { active: !done });

    if (!done && !noChain) {
      const continueUrl = buildBackfillContinueUrl(requestUrl.href, secret || undefined);
      context.waitUntil(
        chainBackfillRequest(continueUrl, secret).catch((err) => {
          console.error('Chain backfill row_fp gagal:', err?.message || err);
        })
      );
    }

    const row_fp = await getRowFpStatsForReport(context.env.DB, meta.totalSekolah);
    const body = {
      status: done ? 'success' : 'in_progress',
      message: done
        ? 'Backfill row_fp selesai.'
        : noChain
          ? `Batch selesai (${batch.processed} baris). Panggil lagi untuk melanjutkan.`
          : 'Backfill berjalan di background. Pantau di halaman status atau stats=1.',
      batch,
      row_fp,
      row_fp_null: remainingAfter,
      row_fp_null_sebelum: remainingBefore,
      selesai: done,
      batch_size: batchSize,
      ...(noChain || done
        ? {}
        : {
            continue_url: buildBackfillContinueUrl(requestUrl.href, undefined).replace(
              /secret=[^&]+/,
              'secret=***'
            ),
          }),
    };

    return new Response(JSON.stringify(body), {
      status: done ? 200 : 202,
      headers: jsonHeaders,
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ status: 'error', message: error.message }),
      { status: 500, headers: jsonHeaders }
    );
  }
}
