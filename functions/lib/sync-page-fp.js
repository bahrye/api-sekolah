import { fingerprintRow } from './sekolah-schema.js';

/**
 * Fingerprint per halaman API — skip baca tabel sekolah jika isi halaman sama dengan sync terakhir.
 */
/** Naik saat PAGE_SIZE berubah (indeks halaman API bergeser). */
export const FP_VERSION = '7';

/**
 * @param {Record<string, string>[]} rows sudah dinormalisasi (mapFromApi)
 */
export async function fingerprintRows(rows) {
  const sorted = [...rows].sort((a, b) => a.NPSN.localeCompare(b.NPSN));
  const rowFps = await Promise.all(sorted.map((r) => fingerprintRow(r)));
  const text = `${FP_VERSION}|${rowFps.join('\x1f')}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {number} pageIndex
 */
export async function getPageFingerprint(db, pageIndex) {
  try {
    const row = await db.prepare(`SELECT fingerprint FROM sync_page_fp WHERE page_index = ?`).bind(pageIndex).first();
    return row?.fingerprint ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {number} pageIndex
 * @param {string} fingerprint
 */
export async function savePageFingerprint(db, pageIndex, fingerprint) {
  await db.prepare(`
    INSERT INTO sync_page_fp (page_index, fingerprint, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (page_index) DO UPDATE SET
      fingerprint = excluded.fingerprint,
      updated_at = CURRENT_TIMESTAMP
  `).bind(pageIndex, fingerprint).run();
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {number[]} pageIndexes
 */
export async function getPageFingerprintsBatch(db, pageIndexes) {
  if (pageIndexes.length === 0) return new Map();
  try {
    const placeholders = pageIndexes.map(() => '?').join(',');
    const { results } = await db.prepare(`
      SELECT page_index, fingerprint FROM sync_page_fp WHERE page_index IN (${placeholders})
    `).bind(...pageIndexes).all();
    return new Map((results || []).map((r) => [r.page_index, r.fingerprint]));
  } catch {
    return new Map();
  }
}
