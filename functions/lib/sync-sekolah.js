import { maybeRecordLastSync } from './sync-meta.js';
import {
  fingerprintRows,
  getPageFingerprintsBatch,
  savePageFingerprint,
} from './sync-page-fp.js';
import { mapFromApi, fingerprintRow, rowChanged, ROW_FP_COLUMN } from './sekolah-schema.js';
import { fetchSekolahByNpsns, flushSekolahWriteQueue } from './sekolah-pg.js';
import {
  CHUNK_RECORDS_LADDER,
  CHUNK_PAGES_LADDER,
  CHUNK_PAGES_TOP,
  CHUNK_PAGES_FLOOR,
  lowerChunkPages,
  higherChunkPages,
  normalizeChunkTier,
  recordsForMaxPages,
  chunkMetTarget,
  shouldStepDownChunk,
} from './sync-chunk-ladder.js';

export {
  CHUNK_RECORDS_LADDER,
  CHUNK_PAGES_LADDER,
  lowerChunkPages,
  higherChunkPages,
  normalizeChunkTier,
  recordsForMaxPages,
  chunkMetTarget,
  shouldStepDownChunk,
};

const API_URL =
  'https://api.data.belajar.id/data-portal-backend/v2/master-data/satuan-pendidikan/daftar-data-induk/360';

/** API belajar.id memakai maks ~20 baris per request (limit=200 tetap mengembalikan 20) */
export const PAGE_SIZE = 20;

export { mapFromApi };

/** ~10 hal × 20 = 200 sekolah per chunk (Worker cron) */
export const DEFAULT_MAX_PAGES = 10;
/** Maks hal per chunk (batas subrequest Worker) */
export const MAX_PAGES_HARD_CAP = 12;
/** Pages Functions: 1 hal (~200 sekolah) */
export const PAGES_SAFE_MAX_PAGES = 1;
/** Target ringan (~400 sekolah = 2 hal) */
export const PAGES_FAST_MAX_PAGES = CHUNK_PAGES_FLOOR;
/** Target penuh (~600 sekolah = 3 hal) */
export const PAGES_FULL_MAX_PAGES = CHUNK_PAGES_TOP;
export const RECORDS_PER_CHUNK = DEFAULT_MAX_PAGES * PAGE_SIZE;
/** Wall untuk 2 hal (~400) saat hampir semua fp_skip */
export const CHUNK_WALL_MS = 45_000;
/** Wall bila ada tulis D1 sedang */
export const CHUNK_WALL_WRITE_MS = 70_000;
/** Wall bila hampir semua baris diubah */
export const CHUNK_WALL_WRITE_HEAVY_MS = 78_000;
/** +3s per hal di atas 2 hal */
export const CHUNK_WALL_MS_PER_PAGE_OVER_FAST = 3_000;

/**
 * @param {number} maxPages
 */
export function chunkWallMsForPages(maxPages) {
  if (maxPages <= PAGES_FAST_MAX_PAGES) return CHUNK_WALL_MS;
  return (
    CHUNK_WALL_MS + (maxPages - PAGES_FAST_MAX_PAGES) * CHUNK_WALL_MS_PER_PAGE_OVER_FAST
  );
}

/**
 * Wall adaptif: chunk dengan banyak `ubah` butuh waktu lebih agar 20 hal (~400) selesai.
 * @param {number} maxPages
 * @param {{ writes?: number }} [opts]
 */
export function chunkWallMsForWorkload(maxPages, { writes = 0 } = {}) {
  const base = chunkWallMsForPages(maxPages);
  if (writes >= 80) return Math.max(base, CHUNK_WALL_WRITE_HEAVY_MS);
  if (writes >= 12) return Math.max(base, CHUNK_WALL_WRITE_MS);
  if (writes >= 4) return Math.max(base, CHUNK_WALL_MS + 8_000);
  return base;
}
export const ESTIMATED_TOTAL_RECORDS = 552578;

/**
 * @param {number} offset
 */
async function fetchPageWithMeta(offset) {
  const url = `${API_URL}?limit=${PAGE_SIZE}&offset=${offset}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'CloudflareCronSync/2.0' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} pada offset ${offset}`);
  }
  const json = await response.json();
  const raw = json.data?.rows ?? json.data;
  const rows = Array.isArray(raw) ? raw : [];
  const total = Number(json.meta?.total) || ESTIMATED_TOTAL_RECORDS;
  return { rows, total };
}

/**
 * @param {number} offset
 */
export function progressPercent(offset) {
  if (offset <= 0) return 0;
  const pct = Math.min(100, (offset / ESTIMATED_TOTAL_RECORDS) * 100);
  return Math.round(pct * 100) / 100;
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {{ offset?: number, maxPages?: number, bootstrapOnly?: boolean }} options
 */
export async function syncSekolahChunk(
  sql,
  { offset = 0, maxPages = DEFAULT_MAX_PAGES, bootstrapOnly = false, wallMs = CHUNK_WALL_MS } = {}
) {
  const stats = {
    scanned: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    row_fp_backfill: 0,
    pages: 0,
    pages_fp_skip: 0,
    pages_fp_saved: 0,
  };

  let currentOffset = offset;
  let pagesProcessed = 0;
  let apiTotal = ESTIMATED_TOTAL_RECORDS;
  let timedOut = false;
  const wallStart = Date.now();

  const pageIndexes = Array.from({ length: maxPages }, (_, i) =>
    Math.floor((offset + i * PAGE_SIZE) / PAGE_SIZE)
  );
  const fpMap = bootstrapOnly ? new Map() : await getPageFingerprintsBatch(sql, pageIndexes);

  while (pagesProcessed < maxPages) {
    if (Date.now() - wallStart >= wallMs) {
      timedOut = true;
      break;
    }

    const { rows: rawPage, total } = await fetchPageWithMeta(currentOffset);
    apiTotal = total;

    if (rawPage.length === 0) {
      await maybeRecordLastSync(sql, stats, true);
      return {
        done: true,
        nextOffset: currentOffset,
        stats,
        progress_percent: 100,
        api_total: apiTotal,
      };
    }

    stats.pages += 1;
    pagesProcessed += 1;

    const rows = rawPage.map(mapFromApi).filter((r) => r.NPSN);
    const pageIndex = Math.floor(currentOffset / PAGE_SIZE);
    const fp = await fingerprintRows(rows);

    if (bootstrapOnly) {
      await savePageFingerprint(sql, pageIndex, fp);
      stats.scanned += rows.length;
      stats.pages_fp_saved += 1;
      currentOffset += PAGE_SIZE;
      if (currentOffset >= apiTotal) {
        await maybeRecordLastSync(sql, stats, true);
        return {
          done: true,
          nextOffset: currentOffset,
          stats,
          progress_percent: 100,
          api_total: apiTotal,
        };
      }
      continue;
    }

    const storedFp = fpMap.get(pageIndex) ?? null;

    if (storedFp && storedFp === fp) {
      stats.scanned += rows.length;
      stats.skipped += rows.length;
      stats.pages_fp_skip += 1;
    } else {
      const npsns = rows.map((r) => r.NPSN);
      const existing = await fetchSekolahByNpsns(sql, npsns);
      const writes = [];
      const rowFps = await Promise.all(rows.map((r) => fingerprintRow(r)));

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        stats.scanned += 1;
        const rowFp = rowFps[i];
        row[ROW_FP_COLUMN] = rowFp;
        const old = existing.get(row.NPSN);

        if (!old) {
          writes.push({ row, kind: 'insert' });
          stats.inserted += 1;
        } else if ((old[ROW_FP_COLUMN] ?? '') === rowFp) {
          stats.skipped += 1;
        } else if (!old[ROW_FP_COLUMN] && !rowChanged(old, row)) {
          writes.push({ row, kind: 'fp_only' });
          stats.row_fp_backfill += 1;
          stats.skipped += 1;
        } else {
          writes.push({ row, kind: 'update' });
          stats.updated += 1;
        }
      }

      if (writes.length > 0) await flushSekolahWriteQueue(sql, writes);

      await savePageFingerprint(sql, pageIndex, fp);
      fpMap.set(pageIndex, fp);
    }

    currentOffset += PAGE_SIZE;

    if (currentOffset >= apiTotal) {
      await maybeRecordLastSync(sql, stats, true);
      return {
        done: true,
        nextOffset: currentOffset,
        stats,
        progress_percent: 100,
        api_total: apiTotal,
        timed_out: false,
      };
    }
  }

  await maybeRecordLastSync(sql, stats, false);

  return {
    done: false,
    nextOffset: currentOffset,
    stats,
    progress_percent: progressPercent(currentOffset),
    api_total: apiTotal,
    timed_out: timedOut,
  };
}

export function chainSyncRequest(nextUrl, secret) {
  const headers = {};
  if (secret) headers['X-Sync-Secret'] = secret;
  return fetch(nextUrl, { headers });
}

export function buildContinueUrl(requestUrl, nextOffset, secret) {
  const next = new URL(requestUrl);
  next.searchParams.set('offset', String(nextOffset));
  if (secret) next.searchParams.set('secret', secret);
  return next.toString();
}
