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
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {number} pageIndex
 */
export async function getPageFingerprint(sql, pageIndex) {
  try {
    const rows = await sql`
      SELECT fingerprint FROM sync_page_fp WHERE page_index = ${pageIndex}
    `;
    return rows[0]?.fingerprint ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {number} pageIndex
 * @param {string} fingerprint
 */
export async function savePageFingerprint(sql, pageIndex, fingerprint) {
  await sql`
    INSERT INTO sync_page_fp (page_index, fingerprint, updated_at)
    VALUES (${pageIndex}, ${fingerprint}, NOW())
    ON CONFLICT (page_index) DO UPDATE SET
      fingerprint = EXCLUDED.fingerprint,
      updated_at = NOW()
  `;
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {number[]} pageIndexes
 */
export async function getPageFingerprintsBatch(sql, pageIndexes) {
  if (pageIndexes.length === 0) return new Map();
  try {
    const rows = await sql`
      SELECT page_index, fingerprint FROM sync_page_fp WHERE page_index = ANY(${pageIndexes})
    `;
    return new Map(rows.map((r) => [r.page_index, r.fingerprint]));
  } catch {
    return new Map();
  }
}
