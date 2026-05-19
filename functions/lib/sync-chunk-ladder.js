/** Tangga ukuran chunk (sekolah): 500 → 480 → 460 → 440 → 420 → 400 */
export const CHUNK_RECORDS_LADDER = [500, 480, 460, 440, 420, 400];

/** 25 → 24 → … → 20 halaman (PAGE_SIZE = 20) */
export const CHUNK_PAGES_LADDER = [25, 24, 23, 22, 21, 20];

export const CHUNK_PAGES_TOP = CHUNK_PAGES_LADDER[0];
export const CHUNK_PAGES_FLOOR = CHUNK_PAGES_LADDER[CHUNK_PAGES_LADDER.length - 1];

/**
 * @param {number} maxPages
 * @param {number} [pageSize]
 */
export function recordsForMaxPages(maxPages, pageSize = 20) {
  return maxPages * pageSize;
}

/**
 * @param {number} scanned
 * @param {number} maxPages
 * @param {number} [pageSize]
 */
export function chunkMetTarget(scanned, maxPages, pageSize = 20) {
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
  return p >= 10 ? 10 : p;
}

/**
 * @param {number} scanned
 * @param {number} maxPages
 * @param {number} [pageSize]
 */
export function shouldStepDownChunk(scanned, maxPages, pageSize = 20) {
  if (maxPages < CHUNK_PAGES_FLOOR) return false;
  return !chunkMetTarget(scanned, maxPages, pageSize);
}
