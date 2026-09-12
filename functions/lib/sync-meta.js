import { metaUpsert, metaGetMany, metaGet, metaDelete } from './db-meta.js';
import { countSekolah } from './sekolah-db.js';
import { recordSinkronisasiSelesai } from './status-sinkronisasi.js';

const KEY_LAST_SYNC = 'last_sync_at';
const KEY_TOTAL = 'total_sekolah';
const KEY_SYNC_OFFSET = 'sync_current_offset';
const KEY_SYNC_STATE = 'sync_run_state';
const KEY_SYNC_API_TOTAL = 'sync_api_total';
const KEY_SYNC_CHUNK_AT = 'sync_last_chunk_at';
const KEY_SYNC_CRON_TICK = 'sync_last_cron_tick';
const KEY_SYNC_CRON_NOTE = 'sync_last_cron_note';
const KEY_SYNC_CRON_ENABLED = 'sync_cron_enabled';
const KEY_CHUNK_LOCK = 'sync_chunk_lock_at';
const KEY_CHUNK_LOCK_OFFSET = 'sync_chunk_lock_offset';
const KEY_SYNC_DRIVER = 'sync_driver';

export const SYNC_DRIVER_CRON = 'cron';
export const SYNC_DRIVER_GITHUB = 'github';

/** Tanpa chunk baru selama ini → dianggap terhenti (cron setiap menit) */
export const STALE_SYNC_MS = 4 * 60 * 1000;

/** Lock minimal sepanjang chunk/burst (~88–110s) — cegah /tick dobel di offset sama */
export const CHUNK_LOCK_TTL_MS = 120_000;

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 */
export async function getApiMeta(db) {
  try {
    const map = await metaGetMany(db, [KEY_LAST_SYNC, KEY_TOTAL]);
    let total = map[KEY_TOTAL] != null ? parseInt(map[KEY_TOTAL], 10) : null;
    if (!Number.isFinite(total) || total <= 0) {
      total = 552578;
    }
    return {
      lastSyncIso: map[KEY_LAST_SYNC] ?? null,
      totalSekolah: total,
    };
  } catch {
    return { lastSyncIso: null, totalSekolah: 552578 };
  }
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 */
export async function getLastSyncAt(db) {
  const meta = await getApiMeta(db);
  return meta.lastSyncIso;
}

/**
 * @param {string} iso
 */
export function formatSyncTimeWib(iso) {
  if (!iso) return '-';
  if (typeof iso === 'string' && iso.includes('WIB')) return iso;
  const s = String(iso).trim();
  let ms = NaN;
  if (s.includes('Z') || s.includes('+') || /T.*[+-]\d{2}/.test(s)) {
    ms = new Date(s).getTime();
  } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) {
    ms = new Date(s.replace(' ', 'T') + 'Z').getTime();
  } else {
    ms = new Date(s).getTime();
  }
  if (isNaN(ms) || !ms) return iso;
  const d = new Date(ms + 7 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const Y = d.getUTCFullYear();
  const M = pad(d.getUTCMonth() + 1);
  const D = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const m = pad(d.getUTCMinutes());
  return `${D}-${M}-${Y} ${h}:${m} WIB`;
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 */
export async function recordLastSyncAt(db) {
  await metaUpsert(db, KEY_LAST_SYNC, new Date().toISOString());
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 * @param {number} delta
 */
export async function incrementTotalSekolah(db, delta) {
  if (delta <= 0) return;
  const current = await metaGet(db, KEY_TOTAL);
  const n = (parseInt(current || '0', 10) || 0) + delta;
  await metaUpsert(db, KEY_TOTAL, n);
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 * @param {{ inserted: number, updated: number }} stats
 * @param {boolean} finished
 */
export async function maybeRecordLastSync(db, stats, finished) {
  const hadWrites = stats.inserted + stats.updated > 0;
  if (stats.inserted > 0) await incrementTotalSekolah(db, stats.inserted);
  if (hadWrites || finished) await recordLastSyncAt(db);
  if (finished) {
    const total = await countSekolah(db);
    await metaUpsert(db, KEY_TOTAL, total);
  }
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 */
export async function getSyncProgress(db) {
  try {
    const map = await metaGetMany(db, [
      KEY_SYNC_OFFSET,
      KEY_SYNC_STATE,
      KEY_SYNC_API_TOTAL,
      KEY_SYNC_CHUNK_AT,
    ]);
    const offset = map[KEY_SYNC_OFFSET] != null ? parseInt(map[KEY_SYNC_OFFSET], 10) : 0;
    const apiTotal = map[KEY_SYNC_API_TOTAL] != null ? parseInt(map[KEY_SYNC_API_TOTAL], 10) : null;
    return {
      currentOffset: Number.isFinite(offset) ? offset : 0,
      runState: map[KEY_SYNC_STATE] ?? 'idle',
      apiTotal: Number.isFinite(apiTotal) ? apiTotal : null,
      lastChunkAt: map[KEY_SYNC_CHUNK_AT] ?? null,
    };
  } catch {
    return { currentOffset: 0, runState: 'idle', apiTotal: null, lastChunkAt: null };
  }
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 * @param {{ nextOffset: number, done: boolean, apiTotal?: number }} opts
 */
export async function recordSyncProgress(db, { nextOffset, done, apiTotal }) {
  let state;
  if (done) {
    state = 'completed';
    await setCronEnabled(db, false);
    try {
      await recordSinkronisasiSelesai(db);
    } catch (err) {
      console.error('recordSinkronisasiSelesai:', err?.message || err);
    }
  } else if (await isSyncManuallyPaused(db)) {
    state = 'stalled';
  } else {
    state = 'running';
  }
  const now = new Date().toISOString();
  await metaUpsert(db, KEY_SYNC_OFFSET, nextOffset);
  await metaUpsert(db, KEY_SYNC_STATE, state);
  await metaUpsert(db, KEY_SYNC_CHUNK_AT, now);
  if (apiTotal != null) await metaUpsert(db, KEY_SYNC_API_TOTAL, apiTotal);
}

/**
 * @param {{ runState?: string, currentOffset?: number, lastChunkAt?: string | null, apiTotal?: number | null }} prog
 * @param {number} apiTotal
 * @param {{ lastTick?: string | null, enabled?: boolean } | null} [cron]
 * @param {{ chunkLocked?: boolean }} [opts]
 */
export function resolveSyncRunState(prog, apiTotal, cron = null, opts = null) {
  const stored = prog.runState ?? 'idle';
  const offset = prog.currentOffset ?? 0;
  const chunkLocked = opts?.chunkLocked === true;

  if (stored === 'completed' || offset >= apiTotal) {
    return { runState: 'completed', stale: false, staleMinutes: 0 };
  }
  if (stored === 'stalled' && offset < apiTotal) {
    if (chunkLocked && cron?.enabled) {
      return { runState: 'running', stale: false, staleMinutes: 0 };
    }
    const chunkAge = prog.lastChunkAt
      ? Date.now() - new Date(prog.lastChunkAt).getTime()
      : STALE_SYNC_MS + 1;
    return {
      runState: 'stalled',
      stale: true,
      staleMinutes: Math.floor(chunkAge / 60_000),
    };
  }
  if (stored !== 'running') {
    return { runState: stored, stale: false, staleMinutes: 0 };
  }
  if (!prog.lastChunkAt) {
    return { runState: 'running', stale: false, staleMinutes: 0 };
  }

  const chunkAge = Date.now() - new Date(prog.lastChunkAt).getTime();

  if (cron?.enabled && cron.lastTick) {
    const tickAge = Date.now() - new Date(cron.lastTick).getTime();
    if (tickAge < 3 * 60_000 && chunkAge > STALE_SYNC_MS && offset < apiTotal) {
      return {
        runState: 'stalled',
        stale: true,
        staleMinutes: Math.floor(chunkAge / 60_000),
        reason: 'cron_jalan_tanpa_chunk',
      };
    }
  }

  if (chunkAge > STALE_SYNC_MS && offset < apiTotal) {
    return {
      runState: 'stalled',
      stale: true,
      staleMinutes: Math.floor(chunkAge / 60_000),
    };
  }

  return { runState: 'running', stale: false, staleMinutes: 0 };
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 */
export async function markSyncStalled(db) {
  await metaUpsert(db, KEY_SYNC_STATE, 'stalled');
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 */
export async function markSyncPaused(db) {
  await setCronEnabled(db, false);
  await markSyncStalled(db);
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 * @param {number} offset
 */
export async function markSyncResumeAt(db, offset) {
  await recordSyncProgress(db, { nextOffset: offset, done: false });
  await setCronEnabled(db, true);
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 * @param {boolean} enabled
 */
export async function setCronEnabled(db, enabled) {
  await metaUpsert(db, KEY_SYNC_CRON_ENABLED, enabled ? '1' : '0');
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 */
export async function isCronEnabled(db) {
  try {
    return (await metaGet(db, KEY_SYNC_CRON_ENABLED)) === '1';
  } catch {
    return false;
  }
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 */
export async function isSyncManuallyPaused(db) {
  if (await isCronEnabled(db)) return false;
  const prog = await getSyncProgress(db);
  if (prog.runState !== 'stalled') return false;
  const meta = await getApiMeta(db);
  const total = prog.apiTotal ?? meta.totalSekolah ?? 0;
  return (prog.currentOffset ?? 0) < total;
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 */
async function getChunkLockTimestamp(db) {
  try {
    const v = await metaGet(db, KEY_CHUNK_LOCK);
    if (!v) return null;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 */
export async function clearStaleChunkLock(db) {
  const lockAt = await getChunkLockTimestamp(db);
  if (lockAt == null) return false;
  if (Date.now() - lockAt >= CHUNK_LOCK_TTL_MS) {
    await releaseChunkLock(db);
    return true;
  }
  return false;
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 */
export async function isChunkLocked(db) {
  try {
    const lockAt = await getChunkLockTimestamp(db);
    if (lockAt == null) return false;
    const age = Date.now() - lockAt;
    return age >= 0 && age < CHUNK_LOCK_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 */
export async function getChunkLockOffset(db) {
  try {
    const v = await metaGet(db, KEY_CHUNK_LOCK_OFFSET);
    if (v == null) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 * @param {number} [offset]
 */
export async function tryAcquireChunkLock(db, offset) {
  await clearStaleChunkLock(db);
  if (await isChunkLocked(db)) return false;
  await metaUpsert(db, KEY_CHUNK_LOCK, new Date().toISOString());
  if (offset != null && Number.isFinite(offset)) {
    await metaUpsert(db, KEY_CHUNK_LOCK_OFFSET, offset);
  }
  return true;
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 */
export async function releaseChunkLock(db) {
  try {
    await metaDelete(db, KEY_CHUNK_LOCK);
    await metaDelete(db, KEY_CHUNK_LOCK_OFFSET);
  } catch {
    /* ignore */
  }
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 * @param {string} note
 */
export async function recordCronTick(db, note) {
  const now = new Date().toISOString();
  await metaUpsert(db, KEY_SYNC_CRON_TICK, now);
  await metaUpsert(db, KEY_SYNC_CRON_NOTE, note);
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 */
export async function getCronHeartbeat(db) {
  try {
    const map = await metaGetMany(db, [
      KEY_SYNC_CRON_TICK,
      KEY_SYNC_CRON_NOTE,
      KEY_SYNC_CRON_ENABLED,
    ]);
    return {
      lastTick: map[KEY_SYNC_CRON_TICK] ?? null,
      lastNote: map[KEY_SYNC_CRON_NOTE] ?? null,
      enabled: map[KEY_SYNC_CRON_ENABLED] === '1',
    };
  } catch {
    return { lastTick: null, lastNote: null, enabled: false };
  }
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 */
export async function markSyncRunStarted(db) {
  const now = new Date().toISOString();
  await setCronEnabled(db, true);
  await metaUpsert(db, KEY_SYNC_OFFSET, '0');
  await metaUpsert(db, KEY_SYNC_STATE, 'running');
  await metaUpsert(db, KEY_SYNC_CHUNK_AT, now);
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 */
export async function getSyncDriver(db) {
  try {
    const v = await metaGet(db, KEY_SYNC_DRIVER);
    return v === SYNC_DRIVER_GITHUB ? SYNC_DRIVER_GITHUB : SYNC_DRIVER_CRON;
  } catch {
    return SYNC_DRIVER_CRON;
  }
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} sql
 * @param {string} driver
 */
export async function setSyncDriver(db, driver) {
  const v =
    driver === SYNC_DRIVER_GITHUB ? SYNC_DRIVER_GITHUB : SYNC_DRIVER_CRON;
  await metaUpsert(db, KEY_SYNC_DRIVER, v);
}
