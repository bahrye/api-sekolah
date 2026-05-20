/** Tangga ukuran chunk (sekolah): ~600 → … → 400 (PAGE_SIZE = 200) */
export const CHUNK_RECORDS_LADDER = [600, 560, 520, 480, 440, 400];

/** 3 → 3 → … → 2 halaman API (200 sekolah/hal) */
export const CHUNK_PAGES_LADDER = [3, 3, 3, 2, 2, 2];

export const CHUNK_PAGES_TOP = CHUNK_PAGES_LADDER[0];
export const CHUNK_PAGES_FLOOR = CHUNK_PAGES_LADDER[CHUNK_PAGES_LADDER.length - 1];

/**
 * @param {number} maxPages
 * @param {number} [pageSize]
 */
export function recordsForMaxPages(maxPages, pageSize = 200) {
  return maxPages * pageSize;
}

/**
 * @param {number} scanned
 * @param {number} maxPages
 * @param {number} [pageSize]
 */
export function chunkMetTarget(scanned, maxPages, pageSize = 200) {
  return scanned >= recordsForMaxPages(maxPages, pageSize) * 0.92;
}

/**
 * Turun satu tingkat di tangga 500→400. Di 400 mengembalikan null.
 * @param {number} currentPages
 */
export function lowerChunkPages(currentPages) {
  const pages = Math.max(1, Math.floor(currentPages));
  for (let i = 0; i < CHUNK_PAGES_LADDER.length; i++) {
    if (pages >= CHUNK_PAGES_LADDER[i]) {
      return i + 1 < CHUNK_PAGES_LADDER.length ? CHUNK_PAGES_LADDER[i + 1] : null;
    }
  }
  return null;
}

/**
 * Naik satu tingkat di tangga (400→420→…→500). Di 500 mengembalikan null.
 * @param {number} currentPages
 */
export function higherChunkPages(currentPages) {
  const pages = Math.max(1, Math.floor(currentPages));
  for (let i = 0; i < CHUNK_PAGES_LADDER.length; i++) {
    if (pages >= CHUNK_PAGES_LADDER[i]) {
      return i > 0 ? CHUNK_PAGES_LADDER[i - 1] : null;
    }
  }
  return CHUNK_PAGES_FLOOR;
}

/**
 * @param {number} pagesHint
 */
export function normalizeChunkTier(pagesHint) {
  const p = Math.max(1, Math.floor(pagesHint) || CHUNK_PAGES_FLOOR);
  for (const t of CHUNK_PAGES_LADDER) {
    if (p >= t) return t;
  }
  return p >= CHUNK_PAGES_FLOOR ? CHUNK_PAGES_FLOOR : p;
}

/**
 * @param {number} scanned
 * @param {number} maxPages
 * @param {number} [pageSize]
 */
export function shouldStepDownChunk(scanned, maxPages, pageSize = 200) {
  if (maxPages < CHUNK_PAGES_FLOOR) return false;
  return !chunkMetTarget(scanned, maxPages, pageSize);
}
