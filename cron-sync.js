/**
 * Worker sinkronisasi — Cloudflare Cron Triggers (scheduled) + HTTP manual (/tick, /run).
 * Respons HTTP cepat; chunk di ctx.waitUntil (background).
 */

/** Tiap menit — lanjutkan sync */
const CF_CRON_TICK = '* * * * *';
/** Senin 01:00 WITA = Minggu 17:00 UTC (cron Cloudflare memakai UTC) */
const CF_CRON_WEEKLY_WITA = '0 17 * * SUN';

/**
 * @param {string} cron
 */
function isWeeklyCronExpr(cron) {
  return (
    cron === CF_CRON_WEEKLY_WITA ||
    cron === '0 17 * * 1' ||
    cron === '0 1 * * 1' ||
    cron === '0 1 * * MON'
  );
}
import {
  syncSekolahChunk,
  PAGE_SIZE,
  chunkWallMsForPages,
  chunkWallMsForWorkload,
  PAGES_SAFE_MAX_PAGES,
  PAGES_FAST_MAX_PAGES,
  PAGES_FULL_MAX_PAGES,
  lowerChunkPages,
  normalizeChunkTier,
  recordsForMaxPages,
  chunkMetTarget,
  ESTIMATED_TOTAL_RECORDS,
} from './functions/lib/sync-sekolah.js';
import { getActivityLog } from './functions/lib/sync-activity-log.js';
import {
  recordSyncProgress,
  markSyncRunStarted,
  markSyncStalled,
  markSyncResumeAt,
  getSyncProgress,
  getApiMeta,
  isCronEnabled,
  isChunkLocked,
  tryAcquireChunkLock,
  getChunkLockOffset,
  releaseChunkLock,
  clearStaleChunkLock,
  recordCronTick,
} from './functions/lib/sync-meta.js';
import { buildSyncStatusReport } from './functions/lib/sync-status.js';
import {
  runBackfillCronBurst,
  getRowFpStatsForReport,
  recordRowFpStats,
  recordRowFpBackfillNote,
  pauseBackfillForSync,
  CRON_BACKFILL_WALL_MS,
  CRON_BACKFILL_MAX_BATCHES,
} from './functions/lib/backfill-row-fp.js';
import {
  appendActivityLog,
  appendCronJobActivityLog,
  appendBackfillActivityLog,
} from './functions/lib/sync-activity-log.js';
import { assertSyncAuthorized } from './functions/lib/sync-auth.js';
import { FAVICON_SYNC_SVG, FAVICON_SYNC_HEADERS } from './functions/lib/sync-favicon.js';

const jsonHeaders = {
  'Content-Type': 'application/json;charset=UTF-8',
  'Access-Control-Allow-Origin': '*',
};

/** Chunk per /tick saat beban normal (bukan burst) */
const CRON_TICK_MAX_CHUNKS = 1;
/** Burst: banyak chunk ringan (fp_skip tinggi) dalam satu background job */
const CRON_TICK_BURST_MAX_CHUNKS_IDLE = 10;
const CRON_TICK_BURST_MAX_CHUNKS_LIGHT = 6;
/** Sync mingguan / run dari offset 0 — burst agresif sejak menit pertama */
const CRON_TICK_BURST_MAX_CHUNKS_WEEKLY = 18;
const CRON_TICK_BURST_WALL_MS = 86_000;
const CRON_TICK_BURST_WALL_WEEKLY_MS = 96_000;
const CRON_BURST_MAX_WRITES_PER_CHUNK = 12;
const CRON_BURST_MIN_FP_RATIO = 0.75;
/** 25×20 = 500 — zona fp_skip / sync mingguan (fallback 400 jika timeout) */
const CRON_TICK_PAGES_FULL = PAGES_FULL_MAX_PAGES;
/** 20×20 = 400 — fallback jika 500 tidak muat */
const CRON_TICK_PAGES_FAST = PAGES_FAST_MAX_PAGES;
/** 10×20 = 200 — fallback stabil */
const CRON_TICK_PAGES_SAFE = PAGES_SAFE_MAX_PAGES;
/** 6×20 = 120 — chunk timeout atau banyak tulis D1 */
const CRON_TICK_PAGES_HEAVY = 6;
/** Batas CPU background (harus > wall tulis berat ~68s + margin D1) */
const CHUNK_EXEC_TIMEOUT_MS = 92_000;
const CHUNK_EXEC_TIMEOUT_BURST_MS = 108_000;
const CHUNK_EXEC_TIMEOUT_WEEKLY_MS = 118_000;
const MANUAL_MAX_CHUNKS = 3;
const MANUAL_WALL_MS = 45_000;

/**
 * Coba 500 (25 hal) jika chunk ringan; turun bertahap 480→…→400 lalu 200/120 jika timeout atau berat.
 * @param {{ kind?: string, offset_from?: number, offset_to?: number, pages?: number, pages_fp_skip?: number, updated?: number, inserted?: number, timed_out?: boolean }} line
 */
function analyzeChunkLine(line) {
  const span = Math.max(0, (line.offset_to ?? 0) - (line.offset_from ?? 0));
  const pagesDone = span > 0 ? span / PAGE_SIZE : line.pages ?? 1;
  return {
    pagesDone,
    pagesUsed: line.pages ?? pagesDone,
    maxPages: line.max_pages ?? line.pages ?? pagesDone,
    fpSkip: line.pages_fp_skip ?? 0,
    writes: (line.updated ?? 0) + (line.inserted ?? 0),
    timedOut: line.timed_out === true,
  };
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {{ preferFull?: boolean }} [opts]
 */
async function pickCronTickMaxPages(db, { preferFull = false } = {}) {
  const log = await getActivityLog(db);
  const chunks = log.filter((l) => l.kind === 'chunk').slice(0, 4);
  const last = chunks[0];

  /** Target utama cron: 400 sekolah (20 hal) */
  if (!last) return CRON_TICK_PAGES_FAST;

  const a = analyzeChunkLine(last);
  const tier = normalizeChunkTier(a.maxPages);
  const scannedApprox = a.pagesDone * PAGE_SIZE;

  /** Banyak ubah → jangan kurangi hal; wall diperpanjang via chunkWallMsForWorkload */

  /** Timeout di atas 400: turun tangga 500→480→…→400, jangan loncat ke 200 */
  if (a.timedOut && tier > CRON_TICK_PAGES_FAST) {
    const lower = lowerChunkPages(tier);
    if (lower) return Math.max(lower, CRON_TICK_PAGES_FAST);
  }

  /** Dua chunk berturut timeout di 20 hal dengan hasil <280 → sementara 10 hal */
  if (chunks.length >= 2) {
    const twoWeakTimeouts = chunks.slice(0, 2).every((c) => {
      const x = analyzeChunkLine(c);
      return (
        x.timedOut &&
        normalizeChunkTier(x.maxPages) <= CRON_TICK_PAGES_FAST &&
        x.pagesDone * PAGE_SIZE < 280
      );
    });
    if (twoWeakTimeouts) return CRON_TICK_PAGES_SAFE;
  }

  if (preferFull) return CRON_TICK_PAGES_FULL;

  if (chunks.length >= 3) {
    const threeAt400 = chunks.slice(0, 3).every((c) => {
      const x = analyzeChunkLine(c);
      return (
        !x.timedOut &&
        x.writes < 50 &&
        chunkMetTarget(x.pagesDone * PAGE_SIZE, CRON_TICK_PAGES_FAST)
      );
    });
    if (threeAt400) return CRON_TICK_PAGES_FULL;
  }

  return CRON_TICK_PAGES_FAST;
}

/**
 * Burst: beberapa chunk per menit jika chunk terakhir ringan (fp_skip tinggi, sedikit tulis).
 * @param {import('@cloudflare/workers-types').D1Database} db
 */
async function evaluateBurstEligibility(db) {
  const log = await getActivityLog(db);
  const chunks = log.filter((l) => l.kind === 'chunk').slice(0, 3);
  if (chunks.length < 2) {
    return { maxChunks: CRON_TICK_MAX_CHUNKS, preferFull: false };
  }

  const analyzed = chunks.map((c) => analyzeChunkLine(c));
  const allLight = analyzed.every(
    (x) =>
      !x.timedOut &&
      x.writes <= CRON_BURST_MAX_WRITES_PER_CHUNK &&
      x.pagesDone > 0 &&
      x.fpSkip / x.pagesDone >= CRON_BURST_MIN_FP_RATIO
  );
  if (!allLight) {
    return { maxChunks: CRON_TICK_MAX_CHUNKS, preferFull: false };
  }

  const allZeroWrites = analyzed.every((x) => x.writes === 0);
  return {
    maxChunks: allZeroWrites
      ? CRON_TICK_BURST_MAX_CHUNKS_IDLE
      : CRON_TICK_BURST_MAX_CHUNKS_LIGHT,
    preferFull: true,
  };
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {{ maxChunks?: number, maxPages?: number, wallMs?: number, preferFull?: boolean, assumeLight?: boolean }} [opts]
 */
async function pickCronBatchPlan(db, opts = {}) {
  const recentWrites = await getRecentChunkWrites(db);

  if (opts.maxChunks != null) {
    const maxPages =
      opts.maxPages ?? (await pickCronTickMaxPages(db, { preferFull: opts.preferFull }));
    return {
      maxChunks: opts.maxChunks,
      maxPages,
      wallMs:
        opts.wallMs ??
        (opts.maxChunks > 1
          ? CRON_TICK_BURST_WALL_MS
          : chunkWallMsForWorkload(maxPages, { writes: recentWrites })),
      recentWrites,
    };
  }

  if (opts.assumeLight) {
    return {
      maxChunks: CRON_TICK_BURST_MAX_CHUNKS_WEEKLY,
      maxPages: opts.maxPages ?? CRON_TICK_PAGES_FULL,
      wallMs: CRON_TICK_BURST_WALL_WEEKLY_MS,
      recentWrites: 0,
      weeklyFast: true,
    };
  }

  const burst = await evaluateBurstEligibility(db);
  const maxPages =
    opts.maxPages ??
    (await pickCronTickMaxPages(db, {
      preferFull: burst.preferFull || opts.preferFull,
    }));

  return {
    maxChunks: burst.maxChunks,
    maxPages,
    wallMs:
      burst.maxChunks > 1
        ? CRON_TICK_BURST_WALL_MS
        : chunkWallMsForWorkload(maxPages, { writes: recentWrites }),
    recentWrites,
  };
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 */
async function getRecentChunkWrites(db) {
  const log = await getActivityLog(db);
  const last = log.find((l) => l.kind === 'chunk');
  if (!last) return 0;
  return (last.updated ?? 0) + (last.inserted ?? 0);
}

/**
 * @param {object} env
 * @param {number} offset
 * @param {number} [maxPages]
 * @param {number} [wallMs]
 */
async function processChunk(env, offset, maxPages, wallMs = chunkWallMsForPages(maxPages)) {
  const result = await syncSekolahChunk(env.DB, { offset, maxPages, wallMs });

  await recordSyncProgress(env.DB, {
    nextOffset: result.nextOffset,
    done: result.done,
    apiTotal: result.api_total,
  });

  await appendActivityLog(env.DB, {
    offsetFrom: offset,
    offsetTo: result.nextOffset,
    stats: {
      ...result.stats,
      max_pages: maxPages,
      timed_out: result.timed_out === true,
    },
    note: `Cron chunk (${maxPages} hal)`,
  });

  return result;
}

/**
 * @param {object} env
 * @param {number} startOffset
 * @param {{ maxChunks?: number, wallMs?: number }} opts
 */
async function runCronBatch(
  env,
  startOffset,
  { maxChunks = 1, wallMs, maxPages, recentWrites } = {}
) {
  const pages = maxPages ?? (await pickCronTickMaxPages(env.DB));
  let writes = recentWrites ?? (await getRecentChunkWrites(env.DB));
  const totalWall =
    wallMs ??
    (maxChunks > 1
      ? CRON_TICK_BURST_WALL_MS
      : chunkWallMsForWorkload(pages, { writes }));
  let offset = startOffset;
  const wallStart = Date.now();
  let chunks = 0;
  let timedOut = false;

  while (chunks < maxChunks) {
    const remaining = totalWall - (Date.now() - wallStart);
    if (remaining < 10_000) break;

    const perChunkWall = Math.min(chunkWallMsForWorkload(pages, { writes }), remaining);
    const result = await processChunk(env, offset, pages, perChunkWall);
    chunks += 1;
    if (result.timed_out) timedOut = true;
    writes = (result.stats?.updated ?? 0) + (result.stats?.inserted ?? 0);

    if (result.done) {
      return { done: true, lastOffset: result.nextOffset, chunks, timedOut, pagesUsed: pages };
    }
    offset = result.nextOffset;

    if (maxChunks > 1 && (result.timed_out || writes > CRON_BURST_MAX_WRITES_PER_CHUNK * 2)) {
      break;
    }
  }

  return { done: false, lastOffset: offset, chunks, timedOut, pagesUsed: pages };
}

/**
 * @param {object} env
 */
async function planResumeCron(env) {
  const prog = await getSyncProgress(env.DB);
  const meta = await getApiMeta(env.DB);
  const apiTotal = prog.apiTotal ?? meta.totalSekolah ?? ESTIMATED_TOTAL_RECORDS;
  const offset = prog.currentOffset ?? 0;
  const state = prog.runState ?? 'idle';
  const enabled = await isCronEnabled(env.DB);

  if (offset >= apiTotal) {
    if (state !== 'completed') {
      await recordSyncProgress(env.DB, { nextOffset: offset, done: true, apiTotal });
    }
    return { action: 'skip', reason: 'completed', offset, apiTotal };
  }

  if (!enabled) {
    return { action: 'skip', reason: 'cron_disabled', offset, apiTotal };
  }

  if (state === 'idle') {
    return { action: 'skip', reason: 'idle', offset, apiTotal };
  }

  if (await isChunkLocked(env.DB)) {
    const lockOffset = await getChunkLockOffset(env.DB);
    return {
      action: 'skip',
      reason: 'chunk_in_progress',
      offset: lockOffset ?? offset,
      apiTotal,
    };
  }

  return { action: 'run', offset, apiTotal, state };
}

/**
 * @param {object} env
 * @param {number} offset
 * @param {{ maxChunks?: number, wallMs?: number }} opts
 */
/**
 * @param {object} env
 * @param {number} offset
 * @param {{ maxChunks?: number, wallMs?: number, maxPages?: number }} opts
 * @param {boolean} [lockHeld] true jika lock sudah diambil di handler /tick
 */
async function executeResumeCron(env, offset, opts = {}, lockHeld = false) {
  if (!lockHeld) {
    await clearStaleChunkLock(env.DB);
    const acquired = await tryAcquireChunkLock(env.DB, offset);
    if (!acquired) {
      await recordCronTick(env.DB, `lewati — chunk masih berjalan @ ${offset}`);
      return { ok: false, skipped: true, reason: 'chunk_in_progress' };
    }
  }

  const prog = await getSyncProgress(env.DB);
  const startOffset = prog.currentOffset ?? offset;
  const plan = await pickCronBatchPlan(env.DB, opts);
  const batchOpts = {
    ...opts,
    maxChunks: opts.maxChunks ?? plan.maxChunks,
    maxPages: opts.maxPages ?? plan.maxPages,
    wallMs: opts.wallMs ?? plan.wallMs,
    recentWrites: plan.recentWrites,
  };
  const burstMode = batchOpts.maxChunks > 1;
  const execTimeout = burstMode
    ? batchOpts.weeklyFast
      ? CHUNK_EXEC_TIMEOUT_WEEKLY_MS
      : CHUNK_EXEC_TIMEOUT_BURST_MS
    : Math.max(CHUNK_EXEC_TIMEOUT_MS, batchOpts.wallMs + 12_000);
  try {
    if (prog.runState === 'stalled') {
      await markSyncResumeAt(env.DB, startOffset);
    }

    await recordCronTick(
      env.DB,
      burstMode
        ? `mulai burst ${batchOpts.maxChunks}×chunk @ ${startOffset} (${batchOpts.maxPages} hal ≈${batchOpts.maxPages * PAGE_SIZE}, wall ${Math.round(batchOpts.wallMs / 1000)}s)`
        : `mulai chunk @ ${startOffset} (${batchOpts.maxPages} hal, ~${batchOpts.maxPages * PAGE_SIZE}, wall ${Math.round(batchOpts.wallMs / 1000)}s)`
    );
    let batch = await Promise.race([
      runCronBatch(env, startOffset, batchOpts),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error('Chunk timeout — proses background melebihi batas waktu')),
          execTimeout
        );
      }),
    ]);

  if (batch.timedOut) {
      const tier = normalizeChunkTier(batchOpts.maxPages);
      const stepDown = lowerChunkPages(tier);
      if (stepDown && stepDown >= CRON_TICK_PAGES_FAST) {
        await recordCronTick(
          env.DB,
          `timeout ${batchOpts.maxPages} hal → lanjut ${stepDown} hal (~${recordsForMaxPages(stepDown)}) @ ${batch.lastOffset}`
        );
        const cont = await runCronBatch(env, batch.lastOffset, {
          ...batchOpts,
          maxPages: stepDown,
          wallMs: chunkWallMsForWorkload(stepDown, { writes: batchOpts.recentWrites ?? 0 }),
        });
        batch = {
          done: cont.done,
          lastOffset: cont.lastOffset,
          chunks: batch.chunks + cont.chunks,
          timedOut: cont.timedOut,
          pagesUsed: stepDown,
        };
      }
    }

    await recordCronTick(
      env.DB,
      batch.done
        ? `selesai @ ${batch.lastOffset}`
        : `chunk OK → offset ${batch.lastOffset} (${batch.chunks} chunk, ${batch.pagesUsed ?? batchOpts.maxPages} hal)`
    );
    if (batch.done) {
      await appendCronJobActivityLog(env.DB, {
        kind: 'cron_tick',
        action: 'selesai',
        detail: `sinkronisasi selesai @ offset ${batch.lastOffset.toLocaleString('id-ID')}`,
        offset: batch.lastOffset,
        apiTotal: prog.apiTotal,
      });
    }
    return { ok: true, batch };
  } catch (err) {
    const msg = err?.message || String(err);
    await recordCronTick(env.DB, `gagal @ ${offset}: ${msg}`);
    await appendCronJobActivityLog(env.DB, {
      kind: 'cron_error',
      action: 'tick_chunk',
      detail: `@ offset ${offset}: ${msg}`,
      offset,
    });
    await markSyncStalled(env.DB);
    throw err;
  } finally {
    await releaseChunkLock(env.DB);
  }
}

/**
 * @param {ExecutionContext} ctx
 * @param {object} env
 * @param {number} offset
 * @param {{ maxChunks?: number, wallMs?: number }} opts
 */
function scheduleResumeInBackground(ctx, env, offset, opts, lockHeld = false) {
  ctx.waitUntil(
    executeResumeCron(env, offset, opts, lockHeld).catch((err) => {
      console.error('Background sync gagal:', err?.message || err);
    })
  );
}

/**
 * @param {object} plan
 */
function skipMessage(plan) {
  if (plan.reason === 'completed') return 'Data sudah lengkap.';
  if (plan.reason === 'cron_disabled') return 'Cron tidak aktif — panggil /run sekali untuk mengaktifkan.';
  if (plan.reason === 'idle') return 'Status idle — panggil /run?offset=... untuk melanjutkan.';
  if (plan.reason === 'chunk_in_progress') return 'Chunk sebelumnya masih berjalan — menunggu selesai.';
  return 'Tidak ada proses.';
}

/**
 * Backfill row_fp — di-await langsung di cron (waitUntil tidak andal di Cron Trigger).
 * @param {object} env
 */
async function runBackfillCronIfDue(env) {
  const meta = await getApiMeta(env.DB);
  const rf = await getRowFpStatsForReport(env.DB, meta.totalSekolah);

  if (rf.selesai) {
    if (rf.backfill_cron || rf.backfill_active) {
      await recordRowFpStats(env.DB, 0, { active: false, cronEnabled: false });
      await recordRowFpBackfillNote(env.DB, 'selesai');
      await appendBackfillActivityLog(env.DB, {
        action: 'selesai',
        detail: 'semua baris sudah punya row_fp',
        processed: 0,
        null_remaining: 0,
      });
      await recordCronTick(env.DB, 'backfill row_fp selesai');
    }
    return { ran: false, reason: 'selesai', logged: true };
  }

  if (!rf.measured || rf.null_count == null || rf.null_count <= 0) {
    return { ran: false, reason: 'belum_diukur' };
  }

  let cronOn = rf.backfill_cron;
  if ((rf.backfill_active && rf.backfill_stale && !cronOn) || (rf.backfill_active && !cronOn)) {
    await recordRowFpStats(env.DB, rf.null_count, { active: true, cronEnabled: true });
    cronOn = true;
  }

  if (!cronOn) {
    return { ran: false, reason: 'cron_nonaktif' };
  }

  const prog = await getSyncProgress(env.DB);
  if (prog.runState === 'running') {
    const detail = 'menunggu — sync mingguan sedang berjalan';
    await recordRowFpBackfillNote(env.DB, detail);
    return { ran: false, reason: 'sync_running' };
  }

  if (await isChunkLocked(env.DB)) {
    const detail = 'menunggu — chunk sync memakai lock';
    await recordRowFpBackfillNote(env.DB, detail);
    await appendBackfillActivityLog(env.DB, {
      action: 'lewati',
      detail,
      null_remaining: rf.null_count,
    });
    await recordCronTick(env.DB, `backfill row_fp lewati (chunk lock)`);
    return { ran: false, reason: 'chunk_lock', logged: true };
  }

  try {
    const result = await runBackfillCronBurst(env.DB, {
      wallMs: CRON_BACKFILL_WALL_MS,
      maxBatches: CRON_BACKFILL_MAX_BATCHES,
    });
    const note = result.done
      ? `selesai (${result.batches} batch)`
      : `${result.batches} batch`;
    const detail = result.done
      ? `selesai (+${result.total_processed.toLocaleString('id-ID')})`
      : `+${result.total_processed.toLocaleString('id-ID')}`;
    await recordRowFpBackfillNote(env.DB, `${note}, sisa ~${result.null_remaining.toLocaleString('id-ID')}`);
    await appendBackfillActivityLog(env.DB, {
      action: result.done ? 'selesai' : 'chunk',
      detail,
      processed: result.total_processed,
      null_remaining: result.null_remaining,
    });
    const cronNote = `backfill row_fp ${detail} (sisa ~${result.null_remaining.toLocaleString('id-ID')})`;
    await recordCronTick(env.DB, cronNote);
    return { ran: true, result, logged: true, cronNote };
  } catch (err) {
    const msg = err?.message || String(err);
    await recordRowFpBackfillNote(env.DB, `gagal: ${msg}`);
    await appendBackfillActivityLog(env.DB, {
      action: 'gagal',
      detail: msg,
      null_remaining: rf.null_count,
    });
    await recordCronTick(env.DB, `backfill row_fp gagal: ${msg}`);
    return { ran: false, reason: 'error', error: msg, logged: true };
  }
}

/**
 * Cloudflare Cron — tiap menit (setara GET /tick).
 * @param {object} env
 * @param {ExecutionContext} ctx
 */
async function runScheduledTick(env, ctx) {
  const backfill = await runBackfillCronIfDue(env);

  const plan = await planResumeCron(env);

  if (plan.action === 'skip') {
    if (!backfill.logged) {
      await recordCronTick(env.DB, `CF Cron lewati — ${plan.reason}`);
    }
    if (plan.reason !== 'completed') {
      await appendCronJobActivityLog(env.DB, {
        kind: 'cron_skip',
        action: plan.reason,
        offset: plan.offset,
        apiTotal: plan.apiTotal,
      });
    }
    return { status: 'skipped', plan, backfill };
  }

  await recordCronTick(env.DB, `CF Cron tick @ ${plan.offset}`);

  const acquired = await tryAcquireChunkLock(env.DB, plan.offset);
  if (!acquired) {
    await recordCronTick(env.DB, `CF Cron lewati — chunk masih berjalan @ ${plan.offset}`);
    await appendCronJobActivityLog(env.DB, {
      kind: 'cron_skip',
      action: 'chunk_in_progress',
      offset: plan.offset,
      apiTotal: plan.apiTotal,
    });
    return { status: 'skipped', reason: 'chunk_in_progress', plan, backfill };
  }

  scheduleResumeInBackground(ctx, env, plan.offset, {}, true);
  return { status: 'accepted', plan, backfill };
}

/**
 * Cloudflare Cron — mingguan Senin 01:00 WITA (setara GET /run?offset=0).
 * @param {object} env
 * @param {ExecutionContext} ctx
 */
async function runScheduledWeeklyRun(env, ctx) {
  const offset = 0;
  await markSyncRunStarted(env.DB);
  await pauseBackfillForSync(env.DB);
  await recordCronTick(env.DB, 'CF Cron run — sync mingguan (mode cepat, fp_skip)');
  await appendCronJobActivityLog(env.DB, {
    kind: 'cron_run',
    action: 'accepted',
    detail: 'sync mingguan · burst 18×500/hal · /tick tiap menit',
    offset,
  });
  scheduleResumeInBackground(ctx, env, offset, { assumeLight: true });
  return { status: 'accepted', offset, mode: 'weekly_fast' };
}

export default {
  async scheduled(event, env, ctx) {
    try {
      if (isWeeklyCronExpr(event.cron)) {
        await runScheduledWeeklyRun(env, ctx);
      } else {
        await runScheduledTick(env, ctx);
      }
    } catch (err) {
      const msg = err?.message || String(err);
      console.error('Cloudflare Cron scheduled error:', msg);
      await recordCronTick(env.DB, `CF Cron gagal: ${msg}`);
      await appendCronJobActivityLog(env.DB, {
        kind: 'cron_error',
        action: 'scheduled',
        detail: msg,
      });
      await markSyncStalled(env.DB);
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/$/, '') || '/';
    const wantsJson =
      url.searchParams.get('format') === 'json' ||
      (request.headers.get('Accept') || '').includes('application/json');

    try {
      if (pathname === '/favicon-sync.svg' || pathname === '/favicon.svg') {
        return new Response(FAVICON_SYNC_SVG, { headers: FAVICON_SYNC_HEADERS });
      }

      if (pathname === '/backfill-tick') {
        const auth = assertSyncAuthorized(request, url, env);
        if (!auth.ok) return auth.response;

        const metaBf = await getApiMeta(env.DB);
        const rfBf = await getRowFpStatsForReport(env.DB, metaBf.totalSekolah);
        if (!rfBf.backfill_cron && rfBf.null_count != null && rfBf.null_count > 0) {
          await recordRowFpStats(env.DB, rfBf.null_count, { active: true, cronEnabled: true });
        }
        const backfill = await runBackfillCronIfDue(env);
        const report = await buildSyncStatusReport(env.DB);
        return new Response(
          JSON.stringify({
            status: 'success',
            backfill,
            row_fp: report.row_fp,
          }),
          { headers: jsonHeaders }
        );
      }

      if (pathname === '/run' || pathname === '/tick') {
        const auth = assertSyncAuthorized(request, url, env);
        if (!auth.ok) return auth.response;

        const waitForResult = url.searchParams.get('wait') === '1';

        if (pathname === '/tick') {
          const backfill = await runBackfillCronIfDue(env);
          const plan = await planResumeCron(env);

          if (plan.action === 'skip') {
            await recordCronTick(env.DB, `lewati — ${plan.reason}`);
            if (plan.reason !== 'completed') {
              await appendCronJobActivityLog(env.DB, {
                kind: 'cron_skip',
                action: plan.reason,
                offset: plan.offset,
                apiTotal: plan.apiTotal,
              });
            }
            return new Response(
              JSON.stringify({
                status: 'skipped',
                reason: plan.reason,
                message: skipMessage(plan),
                offset: plan.offset,
                backfill,
              }),
              { headers: jsonHeaders }
            );
          }

          if (!waitForResult) {
            const acquired = await tryAcquireChunkLock(env.DB, plan.offset);
            if (!acquired) {
              await recordCronTick(env.DB, `lewati — chunk masih berjalan @ ${plan.offset}`);
              await appendCronJobActivityLog(env.DB, {
                kind: 'cron_skip',
                action: 'chunk_in_progress',
                offset: plan.offset,
                apiTotal: plan.apiTotal,
              });
              return new Response(
                JSON.stringify({
                  status: 'skipped',
                  reason: 'chunk_in_progress',
                  message: skipMessage({ reason: 'chunk_in_progress' }),
                  offset: plan.offset,
                }),
                { headers: jsonHeaders }
              );
            }

            await recordCronTick(env.DB, `diterima @ ${plan.offset}`);
            await appendCronJobActivityLog(env.DB, {
              kind: 'cron_tick',
              action: 'accepted',
              detail: 'permintaan diterima, memproses di background',
              offset: plan.offset,
              apiTotal: plan.apiTotal,
            });
            scheduleResumeInBackground(ctx, env, plan.offset, {}, true);
            return new Response(
              JSON.stringify({
                status: 'accepted',
                message:
                  'Chunk dijadwalkan di background. Pantau dashboard status Worker.',
                offset: plan.offset,
                progress_percent: Math.round((plan.offset / plan.apiTotal) * 1000) / 10,
              }),
              { status: 202, headers: jsonHeaders }
            );
          }

          const exec = await executeResumeCron(env, plan.offset, {});
          const report = await buildSyncStatusReport(env.DB);
          return new Response(JSON.stringify({ ...report, cron_tick: exec }), {
            headers: jsonHeaders,
          });
        }

        const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
        const resume = url.searchParams.get('resume') === '1';

        if (offset === 0 && !resume) {
          await markSyncRunStarted(env.DB);
          await pauseBackfillForSync(env.DB);
        } else {
          await markSyncResumeAt(env.DB, offset);
        }

        const weeklyStart = offset === 0 && !resume;
        const fastOff = url.searchParams.get('fast') === '0';
        const burstOn = url.searchParams.get('burst') === '1';
        const assumeLight = weeklyStart ? !fastOff : burstOn;

        const batchOpts = await pickCronBatchPlan(env.DB, {
          maxChunks: waitForResult ? MANUAL_MAX_CHUNKS : undefined,
          wallMs: waitForResult ? MANUAL_WALL_MS : undefined,
          maxPages: weeklyStart ? CRON_TICK_PAGES_FULL : undefined,
          assumeLight,
        });

        if (!waitForResult) {
          await recordCronTick(env.DB, `run diterima @ ${offset}`);
          await appendCronJobActivityLog(env.DB, {
            kind: 'cron_run',
            action: 'accepted',
            detail: resume
              ? 'lanjutkan sync'
              : assumeLight
                ? 'sync mingguan mode cepat (burst 18×500/hal, fp_skip)'
                : 'sync penuh dimulai',
            offset,
          });
          scheduleResumeInBackground(ctx, env, offset, batchOpts);
          return new Response(
            JSON.stringify({
              status: 'accepted',
              message: assumeLight
                ? 'Sync mingguan mode cepat di background (~9.000 sekolah/menit jika data tidak berubah). Pantau dashboard status.'
                : 'Batch dijadwalkan di background. Pantau dashboard status.',
              offset_dimulai: offset,
              mode: assumeLight ? 'weekly_fast' : 'normal',
              perkiraan: assumeLight
                ? `~${CRON_TICK_BURST_MAX_CHUNKS_WEEKLY * CRON_TICK_PAGES_FULL * PAGE_SIZE} sekolah per menit (fp_skip tinggi)`
                : undefined,
            }),
            { status: 202, headers: jsonHeaders }
          );
        }

        await appendCronJobActivityLog(env.DB, {
          kind: 'cron_run',
          action: 'run',
          detail: 'memproses batch (wait=1)',
          offset,
        });
        const batch = await runCronBatch(env, offset, batchOpts);
        const report = await buildSyncStatusReport(env.DB);

        return new Response(
          JSON.stringify({
            ...report,
            status: batch.done ? 'success' : 'accepted',
            message: batch.done
              ? 'Sinkronisasi selesai.'
              : `Batch ${batch.chunks} chunk selesai.`,
            offset_dimulai: offset,
            batch,
          }),
          { headers: jsonHeaders }
        );
      }

      const report = await buildSyncStatusReport(env.DB);

      if (!wantsJson) {
        const { renderSyncStatusHtml } = await import('./functions/lib/sync-status.js');
        return new Response(renderSyncStatusHtml(report), {
          headers: { 'Content-Type': 'text/html;charset=UTF-8' },
        });
      }

      return new Response(JSON.stringify(report), { headers: jsonHeaders });
    } catch (error) {
      await markSyncStalled(env.DB);
      return new Response(JSON.stringify({ status: 'error', message: error.message }), {
        status: 500,
        headers: jsonHeaders,
      });
    }
  },
};
