import {
  fingerprintRow,
  buildRowFpOnlyStatement,
  SELECT_COLS,
  ROW_FP_COLUMN,
} from './sekolah-schema.js';
import { getApiMeta } from './sync-meta.js';

/** Baris per request — aman untuk batas CPU Pages */
export const BACKFILL_BATCH_SIZE = 150;
const WRITE_BATCH = 50;

const KEY_ROW_FP_NULL = 'row_fp_null_count';
const KEY_ROW_FP_STATS_AT = 'row_fp_stats_at';
const KEY_ROW_FP_BACKFILL_ACTIVE = 'row_fp_backfill_active';
const KEY_ROW_FP_BACKFILL_CRON = 'row_fp_backfill_cron';

/** Tanpa pembaruan stats selama ini → chain Pages dianggap mati, cron Worker lanjutkan */
export const BACKFILL_STALE_MS = 5 * 60 * 1000;

/** Batch per tick cron Worker (lebih besar dari Pages) */
export const WORKER_BACKFILL_BATCH_SIZE = 400;

export const PAGES_BACKFILL_URL = 'https://api-sekolah-kita.pages.dev/backfill-row-fp.html';
export const WORKER_SYNC_STATUS_URL =
  'https://api-sekolah-cron.syamsulbahri-agro27b.workers.dev/';

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 */
export async function countNullRowFp(db) {
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM sekolah WHERE ${ROW_FP_COLUMN} IS NULL OR ${ROW_FP_COLUMN} = ''`
      )
      .first();
    return Number(row?.n) || 0;
  } catch {
    return 0;
  }
}

/**
 * Isi row_fp dari kolom data yang sudah ada di D1 (tanpa panggil API belajar.id).
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {number} [batchSize]
 */
export async function backfillRowFpBatch(db, batchSize = BACKFILL_BATCH_SIZE) {
  const limit = Math.max(1, Math.min(500, batchSize));
  const { results } = await db
    .prepare(
      `SELECT ${SELECT_COLS} FROM sekolah WHERE ${ROW_FP_COLUMN} IS NULL OR ${ROW_FP_COLUMN} = '' LIMIT ?`
    )
    .bind(limit)
    .all();

  const rows = results || [];
  if (rows.length === 0) {
    return { processed: 0, updated: 0, done: true };
  }

  const statements = [];
  for (const row of rows) {
    const rowFp = await fingerprintRow(row);
    row[ROW_FP_COLUMN] = rowFp;
    statements.push(buildRowFpOnlyStatement(db, row));
  }

  for (let i = 0; i < statements.length; i += WRITE_BATCH) {
    await db.batch(statements.slice(i, i + WRITE_BATCH));
  }

  return { processed: rows.length, updated: rows.length, done: false };
}

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
 * Simpan perkiraan sisa NULL ke sync_meta (hemat — hindari COUNT(*) tiap polling status).
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {number} nullCount
 * @param {{ active?: boolean }} [opts]
 */
export async function recordRowFpStats(
  db,
  nullCount,
  { active = false, cronEnabled = false } = {}
) {
  const now = new Date().toISOString();
  const upsert = (key, value) =>
    db
      .prepare(
        `INSERT INTO sync_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .bind(key, value);

  await db.batch([
    upsert(KEY_ROW_FP_NULL, String(Math.max(0, nullCount))),
    upsert(KEY_ROW_FP_STATS_AT, now),
    upsert(KEY_ROW_FP_BACKFILL_ACTIVE, active ? '1' : '0'),
    upsert(KEY_ROW_FP_BACKFILL_CRON, cronEnabled ? '1' : '0'),
  ]);
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {number} [batchSize]
 */
export async function runBackfillCronStep(db, batchSize = WORKER_BACKFILL_BATCH_SIZE) {
  const meta = await getApiMeta(db);
  const before = await getRowFpStatsForReport(db, meta.totalSekolah);
  const batch = await backfillRowFpBatch(db, batchSize);

  let nullRemaining = before.null_count ?? 0;
  if (batch.done) {
    nullRemaining = 0;
  } else if (batch.processed > 0) {
    nullRemaining = Math.max(0, nullRemaining - batch.processed);
  }

  const done = batch.done || nullRemaining === 0;
  await recordRowFpStats(db, nullRemaining, {
    active: !done,
    cronEnabled: !done,
  });

  return { batch, null_remaining: nullRemaining, done };
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {number | null} [totalSekolah]
 */
export async function getRowFpStatsForReport(db, totalSekolah = null) {
  try {
    const { results } = await db
      .prepare(`SELECT key, value FROM sync_meta WHERE key IN (?, ?, ?, ?)`)
      .bind(
        KEY_ROW_FP_NULL,
        KEY_ROW_FP_STATS_AT,
        KEY_ROW_FP_BACKFILL_ACTIVE,
        KEY_ROW_FP_BACKFILL_CRON
      )
      .all();

    const map = Object.fromEntries((results || []).map((r) => [r.key, r.value]));
    const nullRaw = map[KEY_ROW_FP_NULL];
    const nullCount = nullRaw != null ? parseInt(nullRaw, 10) : null;
    const total = Number.isFinite(totalSekolah) && totalSekolah > 0 ? totalSekolah : null;
    const filled =
      nullCount != null && total != null ? Math.max(0, total - nullCount) : null;
    const percentFilled =
      filled != null && total != null ? Math.round((filled / total) * 1000) / 10 : null;
    const statsAt = map[KEY_ROW_FP_STATS_AT] ?? null;
    const statsAge = statsAt ? Date.now() - new Date(statsAt).getTime() : BACKFILL_STALE_MS + 1;
    const backfill_active = map[KEY_ROW_FP_BACKFILL_ACTIVE] === '1';
    const backfill_cron = map[KEY_ROW_FP_BACKFILL_CRON] === '1';
    const backfill_stale = backfill_active && statsAge > BACKFILL_STALE_MS;

    return {
      null_count: Number.isFinite(nullCount) ? nullCount : null,
      filled_count: filled,
      total,
      percent_filled: percentFilled,
      selesai: nullCount === 0,
      backfill_active,
      backfill_cron,
      backfill_stale,
      stats_at: statsAt,
      stats_at_wib: statsAt ? formatStatsWib(statsAt) : null,
      measured: nullRaw != null,
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
