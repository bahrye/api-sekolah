import {
  fingerprintRow,
  buildRowFpOnlyStatement,
  SELECT_COLS,
  ROW_FP_COLUMN,
} from './sekolah-schema.js';

/** Baris per request — aman untuk batas CPU Pages */
export const BACKFILL_BATCH_SIZE = 150;
const WRITE_BATCH = 50;

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
