import { getApiMeta, formatSyncTimeWib } from './sync-meta.js';
import { metaUpsert, metaGetMany } from './db-meta.js';
import { countNullRowFp, backfillRowFpBatchDb } from './sekolah-db.js';

export { countNullRowFp };
export const backfillRowFpBatch = backfillRowFpBatchDb;

/** Baris per request Pages (batch pertama; sisanya cron Worker) */
export const BACKFILL_BATCH_SIZE = 400;
/** Maks per query D1 */
export const BACKFILL_BATCH_MAX = 500;
const KEY_ROW_FP_NULL = 'row_fp_null_count';
const KEY_ROW_FP_STATS_AT = 'row_fp_stats_at';
const KEY_ROW_FP_BACKFILL_ACTIVE = 'row_fp_backfill_active';
const KEY_ROW_FP_BACKFILL_CRON = 'row_fp_backfill_cron';
const KEY_ROW_FP_BACKFILL_NOTE = 'row_fp_backfill_note';

/** Cron Trigger: await langsung (batas subrequest Worker ~50) */
export const CRON_BACKFILL_WALL_MS = 26_000;
/** Maks batch per /tick (tiap batch ≈ 2–4 subrequest D1) */
export const CRON_BACKFILL_MAX_BATCHES = 2;

/** Tanpa pembaruan stats selama ini → chain Pages dianggap mati, cron Worker lanjutkan */
export const BACKFILL_STALE_MS = 5 * 60 * 1000;

/** Baris per batch cron Worker (bulk UPDATE) */
export const WORKER_BACKFILL_BATCH_SIZE = 120;
/** Burst Pages (Worker cron pakai CRON_BACKFILL_MAX_BATCHES) */
export const BACKFILL_BURST_MAX_BATCHES = 3;
export const BACKFILL_BURST_WALL_MS = 85_000;

export const PAGES_BACKFILL_URL = 'https://api-sekolah-kita.pages.dev/backfill-row-fp.html';
export const WORKER_SYNC_STATUS_URL =
  'https://api-sekolah-cron.dunia-sekolah.workers.dev/';

/**
 * @param {string} continueUrl
 * @param {string} [secret]
 */
export function chainBackfillRequest(continueUrl, secret) {
  const headers = {};
  if (secret) headers['X-Sync-Secret'] = secret;
  return fetch(continueUrl, { headers });
}

/**
 * @param {string} requestUrl
 * @param {string} [secret]
 */
export function buildBackfillContinueUrl(requestUrl, secret) {
  const next = new URL(requestUrl);
  next.searchParams.delete('stats');
  next.searchParams.delete('wait');
  if (secret) next.searchParams.set('secret', secret);
  return next.toString();
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {number} nullCount
 * @param {{ active?: boolean, cronEnabled?: boolean }} [opts]
 */
export async function recordRowFpStats(db, nullCount, opts = {}) {
  const { active = false, cronEnabled = false } = opts;
  const now = new Date().toISOString();
  const stats = { null_count: Math.max(0, nullCount), stats_at: now };
  await metaUpsert(db, KEY_ROW_FP_STATS, JSON.stringify(stats));
  await metaUpsert(db, KEY_ROW_FP_BACKFILL_ACTIVE, active ? '1' : '0');
  await metaUpsert(db, KEY_ROW_FP_BACKFILL_CRON, cronEnabled ? '1' : '0');
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 */
export async function pauseBackfillForSync(db) {
  const meta = await getApiMeta(db);
  const rf = await getRowFpStatsForReport(db, meta.totalSekolah);
  if (rf.selesai || !rf.backfill_cron) return;
  await recordRowFpStats(db, rf.null_count ?? 0, { active: false, cronEnabled: false });
  await recordRowFpBackfillNote(db, 'dijeda — sync bulanan berjalan');
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {string} note
 */
export async function recordRowFpBackfillNote(db, note) {
  await metaUpsert(db, KEY_ROW_FP_BACKFILL_NOTE, note);
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {{ batchSize?: number, maxBatches?: number, wallMs?: number }} [opts]
 */
export async function runBackfillCronBurst(
  db,
  { batchSize = WORKER_BACKFILL_BATCH_SIZE, maxBatches = BACKFILL_BURST_MAX_BATCHES, wallMs = BACKFILL_BURST_WALL_MS } = {}
) {
  const meta = await getApiMeta(db);
  const before = await getRowFpStatsForReport(db, meta.totalSekolah);
  let nullRemaining = before.null_count ?? 0;

  if (nullRemaining <= 0) {
    await recordRowFpStats(db, 0, { active: false, cronEnabled: false });
    return {
      total_processed: 0,
      batches: 0,
      null_remaining: 0,
      done: true,
      last_batch: { processed: 0, updated: 0, done: true },
    };
  }

  const wallStart = Date.now();
  let totalProcessed = 0;
  let batches = 0;
  let done = false;
  let lastBatch = { processed: 0, updated: 0, done: true };

  /** Tetap di bawah batas subrequest Cloudflare (~50) per invocation */
  const burstCap = Math.min(maxBatches, 3);

  while (batches < burstCap && Date.now() - wallStart < wallMs - 4_000) {
    lastBatch = await backfillRowFpBatchDb(db, batchSize);
    batches += 1;
    totalProcessed += lastBatch.processed;

    if (lastBatch.done) {
      done = true;
      nullRemaining = 0;
      break;
    }

    if (lastBatch.processed === 0) {
      break;
    }

    nullRemaining = Math.max(0, nullRemaining - lastBatch.processed);
  }

  done = done || nullRemaining === 0;
  await recordRowFpStats(db, nullRemaining, {
    active: !done,
    cronEnabled: !done,
  });

  return {
    total_processed: totalProcessed,
    batches,
    null_remaining: nullRemaining,
    done,
    last_batch: lastBatch,
  };
}

/** @deprecated gunakan runBackfillCronBurst — satu batch saja */
export async function runBackfillCronStep(db, batchSize = WORKER_BACKFILL_BATCH_SIZE) {
  const r = await runBackfillCronBurst(db, { batchSize, maxBatches: 1, wallMs: 60_000 });
  return {
    batch: {
      processed: r.total_processed,
      updated: r.total_processed,
      done: r.done,
    },
    null_remaining: r.null_remaining,
    done: r.done,
  };
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {number | null} [totalSekolah]
 */
export async function getRowFpStatsForReport(db, totalSekolah = null) {
  try {
    const map = await metaGetMany(db, [
      KEY_ROW_FP_STATS,
      KEY_ROW_FP_BACKFILL_ACTIVE,
      KEY_ROW_FP_BACKFILL_CRON,
      KEY_ROW_FP_BACKFILL_NOTE,
    ]);
    const statsRaw = map[KEY_ROW_FP_STATS];
    const stats = statsRaw ? JSON.parse(statsRaw) : {};
    const nullCount = stats.null_count ?? await countNullRowFp(db);
    const total = Number.isFinite(totalSekolah) && totalSekolah > 0 ? totalSekolah : null;
    const filled =
      nullCount != null && total != null ? Math.max(0, total - nullCount) : null;
    const percentFilled =
      filled != null && total != null ? Math.round((filled / total) * 1000) / 10 : null;
    const statsAt = stats.stats_at ?? null;
    const statsAge = statsAt ? Date.now() - new Date(statsAt).getTime() : BACKFILL_STALE_MS + 1;
    const backfill_active = map[KEY_ROW_FP_BACKFILL_ACTIVE] === '1';
    const backfill_cron = map[KEY_ROW_FP_BACKFILL_CRON] === '1';
    const backfill_stale = backfill_active && statsAge > BACKFILL_STALE_MS;
    const backfill_note = map[KEY_ROW_FP_BACKFILL_NOTE] ?? null;

    return {
      null_count: Number.isFinite(nullCount) ? nullCount : null,
      filled_count: filled,
      total,
      percent_filled: percentFilled,
      selesai: nullCount === 0,
      backfill_active,
      backfill_cron,
      backfill_stale,
      backfill_note,
      stats_at: statsAt,
      stats_at_wib: statsAt ? formatStatsWib(statsAt) : null,
      measured: statsRaw != null,
      halaman_backfill: PAGES_BACKFILL_URL,
    };
  } catch {
    return {
      null_count: null,
      filled_count: null,
      total: totalSekolah,
      percent_filled: null,
      selesai: false,
      backfill_active: false,
      backfill_cron: false,
      backfill_stale: false,
      stats_at: null,
      stats_at_wib: null,
      measured: false,
      halaman_backfill: PAGES_BACKFILL_URL,
    };
  }
}

/**
 * @param {string} iso
 */
function formatStatsWib(iso) {
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(d);
}
