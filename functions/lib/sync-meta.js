import { metaUpsert, metaGetMany, metaGet, metaDelete } from './pg-meta.js';
import { countSekolah } from './sekolah-pg.js';
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
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 */
export async function getApiMeta(sql) {
  try {
    const map = await metaGetMany(sql, [KEY_LAST_SYNC, KEY_TOTAL]);
    let total = map[KEY_TOTAL] != null ? parseInt(map[KEY_TOTAL], 10) : null;
    if (!Number.isFinite(total)) {
      total = await countSekolah(sql);
    }
    return {
      lastSyncIso: map[KEY_LAST_SYNC] ?? null,
      totalSekolah: Number.isFinite(total) ? total : null,
    };
  } catch {
    return { lastSyncIso: null, totalSekolah: null };
  }
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 */
export async function getLastSyncAt(sql) {
  const meta = await getApiMeta(sql);
  return meta.lastSyncIso;
}

/**
 * @param {string} iso
 */
export function formatSyncTimeWib(iso) {
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(d);
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 */
export async function recordLastSyncAt(sql) {
  await metaUpsert(sql, KEY_LAST_SYNC, new Date().toISOString());
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {number} delta
 */
export async function incrementTotalSekolah(sql, delta) {
  if (delta <= 0) return;
  const current = await metaGet(sql, KEY_TOTAL);
  const n = (parseInt(current || '0', 10) || 0) + delta;
  await metaUpsert(sql, KEY_TOTAL, n);
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {{ inserted: number, updated: number }} stats
 * @param {boolean} finished
 */
export async function maybeRecordLastSync(sql, stats, finished) {
  const hadWrites = stats.inserted + stats.updated > 0;
  if (stats.inserted > 0) await incrementTotalSekolah(sql, stats.inserted);
  if (hadWrites || finished) await recordLastSyncAt(sql);
  if (finished) {
    const total = await countSekolah(sql);
    await metaUpsert(sql, KEY_TOTAL, total);
  }
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 */
export async function getSyncProgress(sql) {
  try {
    const map = await metaGetMany(sql, [
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
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {{ nextOffset: number, done: boolean, apiTotal?: number }} opts
 */
export async function recordSyncProgress(sql, { nextOffset, done, apiTotal }) {
  let state;
  if (done) {
    state = 'completed';
    await setCronEnabled(sql, false);
    try {
      await recordSinkronisasiSelesai(sql);
    } catch (err) {
      console.error('recordSinkronisasiSelesai:', err?.message || err);
    }
  } else if (await isSyncManuallyPaused(sql)) {
    state = 'stalled';
  } else {
    state = 'running';
  }
  const now = new Date().toISOString();
  await metaUpsert(sql, KEY_SYNC_OFFSET, nextOffset);
  await metaUpsert(sql, KEY_SYNC_STATE, state);
  await metaUpsert(sql, KEY_SYNC_CHUNK_AT, now);
  if (apiTotal != null) await metaUpsert(sql, KEY_SYNC_API_TOTAL, apiTotal);
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
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 */
export async function markSyncStalled(sql) {
  await metaUpsert(sql, KEY_SYNC_STATE, 'stalled');
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 */
export async function markSyncPaused(sql) {
  await setCronEnabled(sql, false);
  await markSyncStalled(sql);
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {number} offset
 */
export async function markSyncResumeAt(sql, offset) {
  await recordSyncProgress(sql, { nextOffset: offset, done: false });
  await setCronEnabled(sql, true);
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {boolean} enabled
 */
export async function setCronEnabled(sql, enabled) {
  await metaUpsert(sql, KEY_SYNC_CRON_ENABLED, enabled ? '1' : '0');
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 */
export async function isCronEnabled(sql) {
  try {
    return (await metaGet(sql, KEY_SYNC_CRON_ENABLED)) === '1';
  } catch {
    return false;
  }
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 */
export async function isSyncManuallyPaused(sql) {
  if (await isCronEnabled(sql)) return false;
  const prog = await getSyncProgress(sql);
  if (prog.runState !== 'stalled') return false;
  const meta = await getApiMeta(sql);
  const total = prog.apiTotal ?? meta.totalSekolah ?? 0;
  return (prog.currentOffset ?? 0) < total;
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 */
async function getChunkLockTimestamp(sql) {
  try {
    const v = await metaGet(sql, KEY_CHUNK_LOCK);
    if (!v) return null;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 */
export async function clearStaleChunkLock(sql) {
  const lockAt = await getChunkLockTimestamp(sql);
  if (lockAt == null) return false;
  if (Date.now() - lockAt >= CHUNK_LOCK_TTL_MS) {
    await releaseChunkLock(sql);
    return true;
  }
  return false;
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 */
export async function isChunkLocked(sql) {
  try {
    const lockAt = await getChunkLockTimestamp(sql);
    if (lockAt == null) return false;
    const age = Date.now() - lockAt;
    return age >= 0 && age < CHUNK_LOCK_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 */
export async function getChunkLockOffset(sql) {
  try {
    const v = await metaGet(sql, KEY_CHUNK_LOCK_OFFSET);
    if (v == null) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {number} [offset]
 */
export async function tryAcquireChunkLock(sql, offset) {
  await clearStaleChunkLock(sql);
  if (await isChunkLocked(sql)) return false;
  await metaUpsert(sql, KEY_CHUNK_LOCK, new Date().toISOString());
  if (offset != null && Number.isFinite(offset)) {
    await metaUpsert(sql, KEY_CHUNK_LOCK_OFFSET, offset);
  }
  return true;
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 */
export async function releaseChunkLock(sql) {
  try {
    await metaDelete(sql, KEY_CHUNK_LOCK);
    await metaDelete(sql, KEY_CHUNK_LOCK_OFFSET);
  } catch {
    /* ignore */
  }
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {string} note
 */
export async function recordCronTick(sql, note) {
  const now = new Date().toISOString();
  await metaUpsert(sql, KEY_SYNC_CRON_TICK, now);
  await metaUpsert(sql, KEY_SYNC_CRON_NOTE, note);
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 */
export async function getCronHeartbeat(sql) {
  try {
    const map = await metaGetMany(sql, [
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
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 */
export async function markSyncRunStarted(sql) {
  const now = new Date().toISOString();
  await setCronEnabled(sql, true);
  await metaUpsert(sql, KEY_SYNC_OFFSET, '0');
  await metaUpsert(sql, KEY_SYNC_STATE, 'running');
  await metaUpsert(sql, KEY_SYNC_CHUNK_AT, now);
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 */
export async function getSyncDriver(sql) {
  try {
    const v = await metaGet(sql, KEY_SYNC_DRIVER);
    return v === SYNC_DRIVER_GITHUB ? SYNC_DRIVER_GITHUB : SYNC_DRIVER_CRON;
  } catch {
    return SYNC_DRIVER_CRON;
  }
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {string} driver
 */
export async function setSyncDriver(sql, driver) {
  const v =
    driver === SYNC_DRIVER_GITHUB ? SYNC_DRIVER_GITHUB : SYNC_DRIVER_CRON;
  await metaUpsert(sql, KEY_SYNC_DRIVER, v);
}
