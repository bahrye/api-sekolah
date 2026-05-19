import {
  syncSekolahChunk,
  chainSyncRequest,
  buildContinueUrl,
  MAX_PAGES_HARD_CAP,
  PAGES_SAFE_MAX_PAGES,
  PAGES_FAST_MAX_PAGES,
  chunkWallMsForWorkload,
} from '../lib/sync-sekolah.js';
import {
  recordSyncProgress,
  markSyncRunStarted,
  markSyncStalled,
  isSyncManuallyPaused,
} from '../lib/sync-meta.js';
import { assertSyncAuthorized } from '../lib/sync-auth.js';
import { appendActivityLog } from '../lib/sync-activity-log.js';

const jsonHeaders = {
  'Content-Type': 'application/json;charset=UTF-8',
  'Access-Control-Allow-Origin': '*',
};

/**
 * GET /api/sync?secret=...&offset=0
 * Memproses per chunk lalu melanjutkan otomatis di background (menghindari batas subrequest).
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

  const secret = context.env.SYNC_SECRET;
  const provided =
    requestUrl.searchParams.get('secret') || context.request.headers.get('X-Sync-Secret') || secret;

  const offset = Math.max(0, parseInt(requestUrl.searchParams.get('offset') || '0', 10) || 0);
  const requestedPages = Math.max(
    1,
    parseInt(requestUrl.searchParams.get('maxPages') || String(PAGES_FAST_MAX_PAGES), 10) ||
      PAGES_FAST_MAX_PAGES
  );
  const maxPages = Math.min(MAX_PAGES_HARD_CAP, requestedPages);
  const wallMs = chunkWallMsForWorkload(maxPages, { writes: 20 });
  const bootstrapOnly = requestUrl.searchParams.get('bootstrap_fp') === '1';
  const noChain = requestUrl.searchParams.get('no_chain') === '1';

  try {
    if (await isSyncManuallyPaused(context.env.DB)) {
      return new Response(
        JSON.stringify({
          status: 'paused',
          message: 'Sync dijeda. Lanjutkan lewat Worker: GET /run?offset=...&resume=1&secret=...',
          offset,
        }),
        { headers: jsonHeaders }
      );
    }

    if (offset === 0 && !bootstrapOnly) {
      await markSyncRunStarted(context.env.DB);
    }

    const result = await syncSekolahChunk(context.env.DB, {
      offset,
      maxPages,
      bootstrapOnly,
      wallMs,
    });

    if (!bootstrapOnly) {
      await recordSyncProgress(context.env.DB, {
        nextOffset: result.nextOffset,
        done: result.done,
        apiTotal: result.api_total,
      });
      await appendActivityLog(context.env.DB, {
        offsetFrom: offset,
        offsetTo: result.nextOffset,
        stats: { ...result.stats, max_pages: maxPages },
        note: 'Pages API',
      });
    }

    if (!result.done) {
      if (!noChain) {
        const continueUrl = buildContinueUrl(requestUrl, result.nextOffset, provided || undefined);
        context.waitUntil(
          chainSyncRequest(continueUrl, secret).catch(async (err) => {
            console.error('Chain sync Pages gagal:', err?.message || err);
            await markSyncStalled(context.env.DB);
          })
        );
      }

      return new Response(
        JSON.stringify({
          status: 'in_progress',
          message: bootstrapOnly
            ? 'Bootstrap fingerprint berlanjut di background (tanpa baca tabel sekolah).'
            : noChain
              ? 'Chunk selesai. Panggil lagi dengan offset berikutnya (no_chain=1).'
              : 'Chunk selesai. Sinkronisasi berlanjut otomatis di background (~ribuan request kecil).',
          chunk: result.stats,
          offset_started: offset,
          next_offset: result.nextOffset,
          progress_percent: result.progress_percent,
          api_total: result.api_total,
          timed_out: result.timed_out === true,
          ...(noChain
            ? {}
            : {
                continue_url: buildContinueUrl(requestUrl, result.nextOffset, provided || undefined).replace(
                  /secret=[^&]+/,
                  'secret=***'
                ),
              }),
        }),
        { headers: jsonHeaders }
      );
    }

    return new Response(
      JSON.stringify({
        status: 'success',
        message: bootstrapOnly
          ? 'Bootstrap fingerprint selesai. Sync mingguan berikutnya jauh lebih hemat read.'
          : 'Sinkronisasi selesai (hanya insert/update yang berubah).',
        stats: result.stats,
        progress_percent: result.progress_percent ?? 100,
        next_offset: result.nextOffset,
        api_total: result.api_total,
      }),
      { headers: jsonHeaders }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ status: 'error', message: error.message }),
      { status: 500, headers: jsonHeaders }
    );
  }
}
