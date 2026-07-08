/**
 * Worker sinkronisasi — Cloudflare Cron Triggers (scheduled) + HTTP manual (/tick, /run).
 * Respons HTTP cepat; chunk di ctx.waitUntil (background).
 */

/** Tiap menit — lanjutkan sync */
const CF_CRON_TICK = '* * * * *';
/** Tanggal 8 dan 23 setiap bulan (UTC) */
const CF_CRON_BIWEEKLY = '0 0 8,23 * *';

/**
 * @param {string} cron
 */
function isScheduledSyncExpr(cron) {
  return (
    cron === CF_CRON_BIWEEKLY ||
    cron === '0 0 8,23 * *'
  );
}
import {
  syncSekolahChunk,
  progressPercent,
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
  markSyncPaused,
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
  getSyncDriver,
  setSyncDriver,
  SYNC_DRIVER_GITHUB,
  SYNC_DRIVER_CRON,
} from './functions/lib/sync-meta.js';
import {
  buildSyncStatusReport,
  renderSyncStatusHtml,
  renderWorkerConfigErrorHtml,
} from './functions/lib/sync-status.js';
import { getDb, hasDatabaseUrl, MISSING_DATABASE_URL_MSG } from './functions/lib/db.js';
import {
  runBackfillCronBurst,
  getRowFpStatsForReport,
  recordRowFpStats,
  recordRowFpBackfillNote,
  pauseBackfillForSync,
  countNullRowFp,
  CRON_BACKFILL_WALL_MS,
  CRON_BACKFILL_MAX_BATCHES,
} from './functions/lib/backfill-row-fp.js';
import {
  appendActivityLog,
  appendCronJobActivityLog,
  appendBackfillActivityLog,
} from './functions/lib/sync-activity-log.js';
import { assertSyncAuthorized, resolveSyncAuth } from './functions/lib/sync-auth.js';
import { FAVICON_SYNC_SVG, FAVICON_SYNC_HEADERS } from './functions/lib/sync-favicon.js';

const jsonHeaders = {
  'Content-Type': 'application/json;charset=UTF-8',
  'Access-Control-Allow-Origin': '*',
};

/**
 * @param {object} env
 * @param {boolean} wantsJson
 * @param {string} [detail]
 */
function databaseConfigErrorResponse(env, wantsJson, detail) {
  const msg = detail || MISSING_DATABASE_URL_MSG;
  if (wantsJson) {
    return new Response(
      JSON.stringify({ status: 'error', message: msg, setup_required: true }),
      { status: 503, headers: jsonHeaders }
    );
  }
  return new Response(renderWorkerConfigErrorHtml(msg), {
    status: 503,
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
}

/**
 * @param {object} env
 */
async function safeMarkStalled(env) {
  try {
    if (hasDatabaseUrl(env)) await markSyncStalled(getDb(env));
  } catch {
    /* ignore */
  }
}

/** Chunk per /tick saat beban normal (bukan burst) */
const CRON_TICK_MAX_CHUNKS = 1;
/** Burst ringan — tiap chunk ≈ 10–25 subrequest (Neon bulk + API) */
const CRON_TICK_BURST_MAX_CHUNKS_IDLE = 2;
const CRON_TICK_BURST_MAX_CHUNKS_LIGHT = 1;
/** Sync bulanan — tetap rendah agar tidak melewati batas subrequest Worker */
const CRON_TICK_BURST_MAX_CHUNKS_MONTHLY = 2;
const CRON_TICK_BURST_WALL_MS = 86_000;
const CRON_TICK_BURST_WALL_MONTHLY_MS = 96_000;
const CRON_BURST_MAX_WRITES_PER_CHUNK = 12;
const CRON_BURST_MIN_FP_RATIO = 0.75;
/** 10×20 ≈ 200 — zona fp_skip / sync bulanan */
const CRON_TICK_PAGES_FULL = PAGES_FULL_MAX_PAGES;
/** 6×20 = 120 — fallback */
const CRON_TICK_PAGES_FAST = PAGES_FAST_MAX_PAGES;
/** 4×20 = 80 — fallback stabil */
const CRON_TICK_PAGES_SAFE = PAGES_SAFE_MAX_PAGES;
/** 1 hal — chunk timeout atau banyak tulis D1 */
const CRON_TICK_PAGES_HEAVY = 1;
/** Batas CPU background (harus > wall tulis berat ~68s + margin D1) */
const CHUNK_EXEC_TIMEOUT_MS = 92_000;
const CHUNK_EXEC_TIMEOUT_BURST_MS = 108_000;
const CHUNK_EXEC_TIMEOUT_MONTHLY_MS = 118_000;
const MANUAL_MAX_CHUNKS = 3;
const MANUAL_WALL_MS = 45_000;

/**
 * Coba ~10 hal (200 sekolah) jika chunk ringan; turun bertahap ke 6 lalu 4 hal jika timeout.
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

  /** Target utama cron: ~400 sekolah (2 hal × 200) */
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

  /** Dua chunk berturut timeout di 2 hal dengan hasil <280 sekolah → 1 hal */
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
      maxChunks: CRON_TICK_BURST_MAX_CHUNKS_MONTHLY,
      maxPages: opts.maxPages ?? CRON_TICK_PAGES_FULL,
      wallMs: CRON_TICK_BURST_WALL_MONTHLY_MS,
      recentWrites: 0,
      monthlyFast: true,
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
async function processChunk(db, offset, maxPages, wallMs = chunkWallMsForPages(maxPages)) {
  const result = await syncSekolahChunk(db, { offset, maxPages, wallMs });

  await recordSyncProgress(db, {
    nextOffset: result.nextOffset,
    done: result.done,
    apiTotal: result.api_total,
  });

  await appendActivityLog(db, {
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
  db,
  startOffset,
  { maxChunks = 1, wallMs, maxPages, recentWrites } = {}
) {
  const pages = maxPages ?? (await pickCronTickMaxPages(db));
  let writes = recentWrites ?? (await getRecentChunkWrites(db));
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
    const result = await processChunk(db, offset, pages, perChunkWall);
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

/** 1 hal API (20 sekolah) — untuk GitHub Actions /step (tanpa chunk lock) */
const STEP_WALL_MS = 28_000;

/**
 * Aktifkan sync di offset terakhir (driver GitHub) bila sempat dijeda.
 * @param {import('@cloudflare/workers-types').D1Database} sql
 */
async function ensureGithubSyncRunning(db) {
  const prog = await getSyncProgress(db);
  const meta = await getApiMeta(db);
  const apiTotal = prog.apiTotal ?? meta.totalSekolah ?? ESTIMATED_TOTAL_RECORDS;
  const offset = prog.currentOffset ?? 0;

  if (offset >= apiTotal) {
    return { resumed: false, offset, api_total: apiTotal, status: 'completed' };
  }

  if (!(await isCronEnabled(db))) {
    await setSyncDriver(db, SYNC_DRIVER_GITHUB);
    await markSyncResumeAt(db, offset);
    return { resumed: true, offset, api_total: apiTotal, status: 'running' };
  }

  if ((await getSyncDriver(db)) !== SYNC_DRIVER_GITHUB) {
    await setSyncDriver(db, SYNC_DRIVER_GITHUB);
  }

  return { resumed: false, offset, api_total: apiTotal, status: prog.runState ?? 'running' };
}

/**
 * Satu langkah sync: 1×PAGE_SIZE (20) sekolah, await penuh.
 * @param {object} env
 */
async function executeSyncStep(env) {
  const db = getDb(env);
  await ensureGithubSyncRunning(db);
  const prog = await getSyncProgress(db);
  const meta = await getApiMeta(db);
  const apiTotal = prog.apiTotal ?? meta.totalSekolah ?? ESTIMATED_TOTAL_RECORDS;
  const offset = prog.currentOffset ?? 0;

  if (!await isCronEnabled(db)) {
    return {
      ok: false,
      status: 'paused',
      offset,
      api_total: apiTotal,
      message: 'Sync tidak dapat dilanjutkan — cek DATABASE_URL / status Worker',
    };
  }

  if (offset >= apiTotal) {
    if (prog.runState !== 'completed') {
      await recordSyncProgress(db, { nextOffset: offset, done: true, apiTotal });
    }
    return {
      ok: true,
      status: 'completed',
      offset,
      api_total: apiTotal,
      progress_percent: 100,
    };
  }

  const result = await syncSekolahChunk(db, {
    offset,
    maxPages: 1,
    wallMs: STEP_WALL_MS,
  });

  await recordSyncProgress(db, {
    nextOffset: result.nextOffset,
    done: result.done,
    apiTotal: result.api_total,
  });

  await appendActivityLog(db, {
    offsetFrom: offset,
    offsetTo: result.nextOffset,
    stats: { ...result.stats, max_pages: 1 },
    note: 'GHA step (1 hal)',
  });

  return {
    ok: true,
    status: result.done ? 'completed' : 'running',
    offset: result.nextOffset,
    api_total: result.api_total,
    progress_percent: progressPercent(result.nextOffset),
    stats: result.stats,
    scanned: result.stats?.scanned ?? 0,
  };
}

/**
 * @param {object} env
 */
async function planResumeCron(env) {
  const prog = await getSyncProgress(getDb(env));
  const meta = await getApiMeta(getDb(env));
  const apiTotal = prog.apiTotal ?? meta.totalSekolah ?? ESTIMATED_TOTAL_RECORDS;
  const offset = prog.currentOffset ?? 0;
  const state = prog.runState ?? 'idle';
  const enabled = await isCronEnabled(getDb(env));

  if (offset >= apiTotal) {
    if (state !== 'completed') {
      await recordSyncProgress(getDb(env), { nextOffset: offset, done: true, apiTotal });
    }
    return { action: 'skip', reason: 'completed', offset, apiTotal };
  }

  if (!enabled) {
    return { action: 'skip', reason: 'cron_disabled', offset, apiTotal };
  }

  if ((await getSyncDriver(getDb(env))) === SYNC_DRIVER_GITHUB) {
    return { action: 'skip', reason: 'github_actions', offset, apiTotal };
  }

  if (state === 'idle') {
    return { action: 'skip', reason: 'idle', offset, apiTotal };
  }

  if (await isChunkLocked(getDb(env))) {
    const lockOffset = await getChunkLockOffset(getDb(env));
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
  const db = getDb(env);
  if (!lockHeld) {
    await clearStaleChunkLock(db);
    const acquired = await tryAcquireChunkLock(db, offset);
    if (!acquired) {
      await recordCronTick(db, `lewati — chunk masih berjalan @ ${offset}`);
      return { ok: false, skipped: true, reason: 'chunk_in_progress' };
    }
  }

  const prog = await getSyncProgress(db);
  const startOffset = prog.currentOffset ?? offset;
  const plan = await pickCronBatchPlan(db, opts);
  const batchOpts = {
    ...opts,
    maxChunks: opts.maxChunks ?? plan.maxChunks,
    maxPages: opts.maxPages ?? plan.maxPages,
    wallMs: opts.wallMs ?? plan.wallMs,
    recentWrites: plan.recentWrites,
  };
  const burstMode = batchOpts.maxChunks > 1;
  const execTimeout = burstMode
    ? batchOpts.monthlyFast
      ? CHUNK_EXEC_TIMEOUT_MONTHLY_MS
      : CHUNK_EXEC_TIMEOUT_BURST_MS
    : Math.max(CHUNK_EXEC_TIMEOUT_MS, batchOpts.wallMs + 12_000);
  try {
    if (prog.runState === 'stalled') {
      await markSyncResumeAt(db, startOffset);
    }

    await recordCronTick(
      db,
      burstMode
        ? `mulai burst ${batchOpts.maxChunks}×chunk @ ${startOffset} (${batchOpts.maxPages} hal ≈${batchOpts.maxPages * PAGE_SIZE}, wall ${Math.round(batchOpts.wallMs / 1000)}s)`
        : `mulai chunk @ ${startOffset} (${batchOpts.maxPages} hal, ~${batchOpts.maxPages * PAGE_SIZE}, wall ${Math.round(batchOpts.wallMs / 1000)}s)`
    );
    let batch = await Promise.race([
      runCronBatch(db, startOffset, batchOpts),
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
          db,
          `timeout ${batchOpts.maxPages} hal → lanjut ${stepDown} hal (~${recordsForMaxPages(stepDown)}) @ ${batch.lastOffset}`
        );
        const cont = await runCronBatch(db, batch.lastOffset, {
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
      db,
      batch.done
        ? `selesai @ ${batch.lastOffset}`
        : `chunk OK → offset ${batch.lastOffset} (${batch.chunks} chunk, ${batch.pagesUsed ?? batchOpts.maxPages} hal)`
    );
    if (batch.done) {
      await appendCronJobActivityLog(db, {
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
    await recordCronTick(db, `gagal @ ${offset}: ${msg}`);
    await appendCronJobActivityLog(db, {
      kind: 'cron_error',
      action: 'tick_chunk',
      detail: `@ offset ${offset}: ${msg}`,
      offset,
    });
    await safeMarkStalled(env);
    throw err;
  } finally {
    await releaseChunkLock(db);
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
  if (plan.reason === 'github_actions') return 'Sync dijalankan GitHub Actions (/step) — Cloudflare Cron hanya backfill row_fp.';
  return 'Tidak ada proses.';
}

/**
 * Backfill row_fp — di-await langsung di cron (waitUntil tidak andal di Cron Trigger).
 * @param {object} env
 */
async function runBackfillCronIfDue(env) {
  const db = getDb(env);
  const meta = await getApiMeta(db);
  const rf = await getRowFpStatsForReport(db, meta.totalSekolah);

  if (rf.selesai) {
    if (rf.backfill_cron || rf.backfill_active) {
      await recordRowFpStats(db, 0, { active: false, cronEnabled: false });
      await recordRowFpBackfillNote(db, 'selesai');
      await appendBackfillActivityLog(db, {
        action: 'selesai',
        detail: 'semua baris sudah punya row_fp',
        processed: 0,
        null_remaining: 0,
      });
      await recordCronTick(db, 'backfill row_fp selesai');
    }
    return { ran: false, reason: 'selesai', logged: true };
  }

  if (!rf.measured || rf.null_count == null || rf.null_count <= 0) {
    return { ran: false, reason: 'belum_diukur' };
  }

  let cronOn = rf.backfill_cron;
  if ((rf.backfill_active && rf.backfill_stale && !cronOn) || (rf.backfill_active && !cronOn)) {
    await recordRowFpStats(db, rf.null_count, { active: true, cronEnabled: true });
    cronOn = true;
  }

  if (!cronOn) {
    return { ran: false, reason: 'cron_nonaktif' };
  }

  const prog = await getSyncProgress(db);
  if (prog.runState === 'running') {
    const detail = 'menunggu — sync bulanan sedang berjalan';
    await recordRowFpBackfillNote(db, detail);
    return { ran: false, reason: 'sync_running' };
  }

  if (await isChunkLocked(db)) {
    const detail = 'menunggu — chunk sync memakai lock';
    await recordRowFpBackfillNote(db, detail);
    await appendBackfillActivityLog(db, {
      action: 'lewati',
      detail,
      null_remaining: rf.null_count,
    });
    await recordCronTick(db, `backfill row_fp lewati (chunk lock)`);
    return { ran: false, reason: 'chunk_lock', logged: true };
  }

  try {
    const result = await runBackfillCronBurst(db, {
      wallMs: CRON_BACKFILL_WALL_MS,
      maxBatches: CRON_BACKFILL_MAX_BATCHES,
    });
    const note = result.done
      ? `selesai (${result.batches} batch)`
      : `${result.batches} batch`;
    const detail = result.done
      ? `selesai (+${result.total_processed.toLocaleString('id-ID')})`
      : `+${result.total_processed.toLocaleString('id-ID')}`;
    await recordRowFpBackfillNote(db, `${note}, sisa ~${result.null_remaining.toLocaleString('id-ID')}`);
    await appendBackfillActivityLog(db, {
      action: result.done ? 'selesai' : 'chunk',
      detail,
      processed: result.total_processed,
      null_remaining: result.null_remaining,
    });
    const cronNote = `backfill row_fp ${detail} (sisa ~${result.null_remaining.toLocaleString('id-ID')})`;
    await recordCronTick(db, cronNote);
    return { ran: true, result, logged: true, cronNote };
  } catch (err) {
    const msg = err?.message || String(err);
    await recordRowFpBackfillNote(db, `gagal: ${msg}`);
    await appendBackfillActivityLog(db, {
      action: 'gagal',
      detail: msg,
      null_remaining: rf.null_count,
    });
    await recordCronTick(db, `backfill row_fp gagal: ${msg}`);
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
      await recordCronTick(getDb(env), `CF Cron lewati — ${plan.reason}`);
    }
    if (plan.reason !== 'completed') {
      await appendCronJobActivityLog(getDb(env), {
        kind: 'cron_skip',
        action: plan.reason,
        offset: plan.offset,
        apiTotal: plan.apiTotal,
      });
    }
    return { status: 'skipped', plan, backfill };
  }

  await recordCronTick(getDb(env), `CF Cron tick @ ${plan.offset}`);

  const acquired = await tryAcquireChunkLock(getDb(env), plan.offset);
  if (!acquired) {
    await recordCronTick(getDb(env), `CF Cron lewati — chunk masih berjalan @ ${plan.offset}`);
    await appendCronJobActivityLog(getDb(env), {
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
 * Cloudflare Cron — bulanan Tanggal 1 01:00 WITA (setara GET /run?offset=0).
 * @param {object} env
 * @param {ExecutionContext} ctx
 */
async function runScheduledMonthlyRun(env, ctx) {
  const offset = 0;
  await markSyncRunStarted(getDb(env));
  await pauseBackfillForSync(getDb(env));
  await recordCronTick(getDb(env), 'CF Cron run — sync terjadwal (mode cepat, fp_skip)');
  await appendCronJobActivityLog(getDb(env), {
    kind: 'cron_run',
    action: 'accepted',
    detail: 'sync terjadwal 15 hari · burst 2×3 hal',
    offset,
  });
  scheduleResumeInBackground(ctx, env, offset, { assumeLight: true });
  return { status: 'accepted', offset, mode: 'biweekly_fast' };
}

export default {
  async scheduled(event, env, ctx) {
    if (isScheduledSyncExpr(event.cron)) {
       return runScheduledMonthlyRun(env, ctx);
    }
    // Jika ada trigger lain, jalankan tick reguler
    return runScheduledTick(env, ctx);
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

      if (!hasDatabaseUrl(env)) {
        return databaseConfigErrorResponse(env, wantsJson);
      }

      if (pathname === '/pause') {
        const auth = resolveSyncAuth(request, url, env, { soft: true });
        if (!auth.ok) {
          if (auth.ignored) {
            const report = await buildSyncStatusReport(getDb(env));
            return new Response(
              JSON.stringify({
                status: 'ignored',
                message: auth.message,
                report,
              }),
              { headers: jsonHeaders }
            );
          }
          return auth.response;
        }

        const prog = await getSyncProgress(getDb(env));
        const offset = prog.currentOffset ?? 0;
        await releaseChunkLock(getDb(env));
        await markSyncPaused(getDb(env));
        await recordCronTick(getDb(env), `sync dijeda manual @ offset ${offset}`);
        await appendCronJobActivityLog(getDb(env), {
          kind: 'cron_skip',
          action: 'paused',
          detail: `sync dijeda @ offset ${offset.toLocaleString('id-ID')}`,
          offset,
        });

        const report = await buildSyncStatusReport(getDb(env));
        return new Response(
          JSON.stringify({
            status: 'success',
            message: 'Sync dijeda. Cron /tick tidak akan melanjutkan sampai /run?resume=1.',
            offset,
            report,
          }),
          { headers: jsonHeaders }
        );
      }

      if (pathname === '/backfill-measure' || pathname === '/backfill-start' || pathname === '/backfill-stop') {
        const auth = resolveSyncAuth(request, url, env, { soft: true });
        const db = getDb(env);
        const metaBf = await getApiMeta(db);

        if (!auth.ok) {
          if (auth.ignored) {
            const report = await buildSyncStatusReport(db);
            return new Response(
              JSON.stringify({
                status: 'ignored',
                message: auth.message,
                row_fp: report.row_fp,
              }),
              { headers: jsonHeaders }
            );
          }
          return auth.response;
        }

        if (pathname === '/backfill-measure') {
          const remaining = await countNullRowFp(db);
          await recordRowFpStats(db, remaining, {
            active: false,
            cronEnabled: false,
          });
          const row_fp = await getRowFpStatsForReport(db, metaBf.totalSekolah);
          return new Response(
            JSON.stringify({
              status: 'success',
              message: 'Pengukuran selesai.',
              row_fp,
              row_fp_null: remaining,
            }),
            { headers: jsonHeaders }
          );
        }

        if (pathname === '/backfill-start') {
          const remaining = await countNullRowFp(db);
          if (remaining <= 0) {
            await recordRowFpStats(db, 0, { active: false, cronEnabled: false });
            await recordRowFpBackfillNote(db, 'sudah 100%');
            const row_fp = await getRowFpStatsForReport(db, metaBf.totalSekolah);
            return new Response(
              JSON.stringify({
                status: 'success',
                message: 'Semua baris sudah punya row_fp.',
                row_fp,
              }),
              { headers: jsonHeaders }
            );
          }
          await recordRowFpStats(db, remaining, { active: true, cronEnabled: true });
          await recordRowFpBackfillNote(db, 'dimulai dari dashboard');
          await appendBackfillActivityLog(db, {
            action: 'mulai',
            detail: 'backfill row_fp dari dashboard',
            null_remaining: remaining,
          });
          const backfill = await runBackfillCronIfDue(env);
          const report = await buildSyncStatusReport(db);
          return new Response(
            JSON.stringify({
              status: 'success',
              message: 'Backfill diaktifkan (cron /tick melanjutkan).',
              backfill,
              row_fp: report.row_fp,
            }),
            { headers: jsonHeaders }
          );
        }

        const rfStop = await getRowFpStatsForReport(db, metaBf.totalSekolah);
        await recordRowFpStats(db, rfStop.null_count ?? 0, {
          active: false,
          cronEnabled: false,
        });
        await recordRowFpBackfillNote(db, 'dihentikan dari dashboard');
        await appendBackfillActivityLog(db, {
          action: 'henti',
          detail: 'backfill row_fp dihentikan manual',
          null_remaining: rfStop.null_count,
        });
        const report = await buildSyncStatusReport(db);
        return new Response(
          JSON.stringify({
            status: 'success',
            message: 'Backfill row_fp dihentikan.',
            row_fp: report.row_fp,
          }),
          { headers: jsonHeaders }
        );
      }

      if (pathname === '/backfill-tick') {
        const auth = assertSyncAuthorized(request, url, env);
        if (!auth.ok) return auth.response;

        const metaBf = await getApiMeta(getDb(env));
        const rfBf = await getRowFpStatsForReport(getDb(env), metaBf.totalSekolah);
        if (!rfBf.backfill_cron && rfBf.null_count != null && rfBf.null_count > 0) {
          await recordRowFpStats(getDb(env), rfBf.null_count, { active: true, cronEnabled: true });
        }
        const backfill = await runBackfillCronIfDue(env);
        const report = await buildSyncStatusReport(getDb(env));
        return new Response(
          JSON.stringify({
            status: 'success',
            backfill,
            row_fp: report.row_fp,
          }),
          { headers: jsonHeaders }
        );
      }

      if (pathname === '/resume') {
        const auth = resolveSyncAuth(request, url, env, { soft: false });
        if (!auth.ok) return auth.response;
        const db = getDb(env);
        const info = await ensureGithubSyncRunning(db);
        return new Response(JSON.stringify({ status: 'ok', ...info }), {
          headers: jsonHeaders,
        });
      }

      if (pathname === '/step') {
        const auth = resolveSyncAuth(request, url, env, { soft: false });
        if (!auth.ok) return auth.response;

        try {
          const body = await executeSyncStep(env);
          const httpStatus =
            body.ok || body.status === 'completed' || body.status === 'paused' ? 200 : 409;
          return new Response(JSON.stringify(body), {
            status: httpStatus,
            headers: jsonHeaders,
          });
        } catch (err) {
          const msg = err?.message || String(err);
          await safeMarkStalled(env);
          return new Response(
            JSON.stringify({ ok: false, status: 'error', message: msg }),
            { status: 500, headers: jsonHeaders }
          );
        }
      }

      if (pathname === '/run' || pathname === '/tick') {
        const softRun = pathname === '/run';
        const auth = resolveSyncAuth(request, url, env, { soft: softRun });
        if (!auth.ok) {
          if (auth.ignored) {
            const report = await buildSyncStatusReport(getDb(env));
            return new Response(
              JSON.stringify({
                status: 'ignored',
                message: auth.message,
                report,
              }),
              { headers: jsonHeaders }
            );
          }
          return auth.response;
        }

        const waitForResult = url.searchParams.get('wait') === '1';

        if (pathname === '/tick') {
          const backfill = await runBackfillCronIfDue(env);
          const plan = await planResumeCron(env);

          if (plan.action === 'skip') {
            await recordCronTick(getDb(env), `lewati — ${plan.reason}`);
            if (plan.reason !== 'completed') {
              await appendCronJobActivityLog(getDb(env), {
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
            const acquired = await tryAcquireChunkLock(getDb(env), plan.offset);
            if (!acquired) {
              await recordCronTick(getDb(env), `lewati — chunk masih berjalan @ ${plan.offset}`);
              await appendCronJobActivityLog(getDb(env), {
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

            await recordCronTick(getDb(env), `diterima @ ${plan.offset}`);
            await appendCronJobActivityLog(getDb(env), {
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
          const report = await buildSyncStatusReport(getDb(env));
          return new Response(JSON.stringify({ ...report, cron_tick: exec }), {
            headers: jsonHeaders,
          });
        }

        const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
        const resume = url.searchParams.get('resume') === '1';
        const sqlRun = getDb(env);
        const driver =
          url.searchParams.get('driver') === 'github'
            ? SYNC_DRIVER_GITHUB
            : SYNC_DRIVER_CRON;
        await setSyncDriver(sqlRun, driver);

        if (offset === 0 && !resume) {
          await markSyncRunStarted(sqlRun);
          await pauseBackfillForSync(sqlRun);
        } else {
          await markSyncResumeAt(sqlRun, offset);
        }

        const monthlyStart = offset === 0 && !resume;
        const fastOff = url.searchParams.get('fast') === '0';
        const burstOn = url.searchParams.get('burst') === '1';
        const assumeLight = monthlyStart ? !fastOff : burstOn;

        const batchOpts = await pickCronBatchPlan(getDb(env), {
          maxChunks: waitForResult ? MANUAL_MAX_CHUNKS : undefined,
          wallMs: waitForResult ? MANUAL_WALL_MS : undefined,
          maxPages: monthlyStart ? CRON_TICK_PAGES_FULL : undefined,
          assumeLight,
        });

        if (!waitForResult) {
          await recordCronTick(getDb(env), `run diterima @ ${offset}`);
          await appendCronJobActivityLog(getDb(env), {
            kind: 'cron_run',
            action: 'accepted',
            detail: resume
              ? 'lanjutkan sync'
              : assumeLight
                ? 'sync bulanan mode cepat (burst 2×3 hal, fp_skip)'
                : 'sync penuh dimulai',
            offset,
          });
          scheduleResumeInBackground(ctx, env, offset, batchOpts);
          return new Response(
            JSON.stringify({
              status: 'accepted',
              message: assumeLight
                ? 'Sync bulanan mode cepat di background (~1.200 sekolah/menit jika fp_skip tinggi). Pantau dashboard status.'
                : 'Batch dijadwalkan di background. Pantau dashboard status.',
              offset_dimulai: offset,
              mode: assumeLight ? 'monthly_fast' : 'normal',
              perkiraan: assumeLight
                ? `~${CRON_TICK_BURST_MAX_CHUNKS_MONTHLY * CRON_TICK_PAGES_FULL * PAGE_SIZE} sekolah/menit (fp_skip tinggi, 20 baris/hal API)`
                : undefined,
            }),
            { status: 202, headers: jsonHeaders }
          );
        }

        await appendCronJobActivityLog(getDb(env), {
          kind: 'cron_run',
          action: 'run',
          detail: 'memproses batch (wait=1)',
          offset,
        });
        const batch = await runCronBatch(getDb(env), offset, batchOpts);
        const report = await buildSyncStatusReport(getDb(env));

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

      // Halaman monitoring dibuat publik agar mudah diakses
      // (Endpoint aksi seperti /run atau /pause tetap memiliki otorisasi mandiri)

      const report = await buildSyncStatusReport(getDb(env));

      if (!wantsJson) {
        return new Response(renderSyncStatusHtml(report), {
          headers: { 'Content-Type': 'text/html;charset=UTF-8' },
        });
      }

      return new Response(JSON.stringify(report), { headers: jsonHeaders });
    } catch (error) {
      console.error('Worker fetch error:', error?.message || error);
      const msg = error?.message || String(error);
      const schemaHint =
        /sync_meta|sync_page_fp|does not exist|relation/i.test(msg)
          ? ' Jalankan sekali: npm run neon:schema'
          : '';
      if (!wantsJson && (msg.includes('DATABASE_URL') || schemaHint)) {
        return databaseConfigErrorResponse(env, wantsJson, msg + schemaHint);
      }
      await safeMarkStalled(env);
      if (!wantsJson) {
        return new Response(renderWorkerConfigErrorHtml(msg + schemaHint), {
          status: 500,
          headers: { 'Content-Type': 'text/html;charset=UTF-8' },
        });
      }
      return new Response(JSON.stringify({ status: 'error', message: msg + schemaHint }), {
        status: 500,
        headers: jsonHeaders,
      });
    }
  },
};
