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

/** Tanpa chunk baru selama ini → dianggap terhenti (cron setiap menit) */
export const STALE_SYNC_MS = 4 * 60 * 1000;

/** Lock minimal sepanjang chunk/burst (~88–110s) — cegah /tick dobel di offset sama */
export const CHUNK_LOCK_TTL_MS = 120_000;

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 */
export async function getApiMeta(db) {
  try {
    const { results } = await db
      .prepare(`SELECT key, value FROM sync_meta WHERE key IN (?, ?)`)
      .bind(KEY_LAST_SYNC, KEY_TOTAL)
      .all();

    const map = Object.fromEntries((results || []).map((r) => [r.key, r.value]));
    const total = map[KEY_TOTAL] != null ? parseInt(map[KEY_TOTAL], 10) : null;

    return {
      lastSyncIso: map[KEY_LAST_SYNC] ?? null,
      totalSekolah: Number.isFinite(total) ? total : null,
    };
  } catch {
    return { lastSyncIso: null, totalSekolah: null };
  }
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 */
export async function getLastSyncAt(db) {
  const meta = await getApiMeta(db);
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
 * @param {import('@cloudflare/workers-types').D1Database} db
 */
export async function recordLastSyncAt(db) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO sync_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .bind(KEY_LAST_SYNC, now)
    .run();
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {number} delta
 */
export async function incrementTotalSekolah(db, delta) {
  if (delta <= 0) return;
  await db
    .prepare(
      `UPDATE sync_meta SET value = CAST((CAST(value AS INTEGER) + ?) AS TEXT) WHERE key = ?`
    )
    .bind(delta, KEY_TOTAL)
    .run();
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {{ inserted: number, updated: number }} stats
 * @param {boolean} finished
 */
export async function maybeRecordLastSync(db, stats, finished) {
  const hadWrites = stats.inserted + stats.updated > 0;

  if (stats.inserted > 0) {
    await incrementTotalSekolah(db, stats.inserted);
  }

  if (hadWrites || finished) {
    await recordLastSyncAt(db);
  }
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 */
export async function getSyncProgress(db) {
  try {
    const { results } = await db
      .prepare(
        `SELECT key, value FROM sync_meta WHERE key IN (?, ?, ?, ?)`
      )
      .bind(KEY_SYNC_OFFSET, KEY_SYNC_STATE, KEY_SYNC_API_TOTAL, KEY_SYNC_CHUNK_AT)
      .all();

    const map = Object.fromEntries((results || []).map((r) => [r.key, r.value]));
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
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {{ nextOffset: number, done: boolean, apiTotal?: number }} opts
 */
export async function recordSyncProgress(db, { nextOffset, done, apiTotal }) {
  const state = done ? 'completed' : 'running';
  if (done) {
    await setCronEnabled(db, false);
  }
  const now = new Date().toISOString();
  const statements = [
    db
      .prepare(
        `INSERT INTO sync_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .bind(KEY_SYNC_OFFSET, String(nextOffset)),
    db
      .prepare(
        `INSERT INTO sync_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .bind(KEY_SYNC_STATE, state),
    db
      .prepare(
        `INSERT INTO sync_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .bind(KEY_SYNC_CHUNK_AT, now),
  ];

  if (apiTotal != null) {
    statements.push(
      db
        .prepare(
          `INSERT INTO sync_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        )
        .bind(KEY_SYNC_API_TOTAL, String(apiTotal))
    );
  }

  await db.batch(statements);
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
    if (chunkLocked) {
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
 * @param {import('@cloudflare/workers-types').D1Database} db
 */
export async function markSyncStalled(db) {
  await db
    .prepare(
      `INSERT INTO sync_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .bind(KEY_SYNC_STATE, 'stalled')
    .run();
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 */
/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {number} offset
 */
export async function markSyncResumeAt(db, offset) {
  await recordSyncProgress(db, { nextOffset: offset, done: false });
  await setCronEnabled(db, true);
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {boolean} enabled
 */
export async function setCronEnabled(db, enabled) {
  await db
    .prepare(
      `INSERT INTO sync_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .bind(KEY_SYNC_CRON_ENABLED, enabled ? '1' : '0')
    .run();
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 */
export async function isCronEnabled(db) {
  try {
    const row = await db
      .prepare('SELECT value FROM sync_meta WHERE key = ?')
      .bind(KEY_SYNC_CRON_ENABLED)
      .first();
    return row?.value === '1';
  } catch {
    return false;
  }
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @returns {Promise<number | null>}
 */
async function getChunkLockTimestamp(db) {
  try {
    const row = await db
      .prepare('SELECT value FROM sync_meta WHERE key = ?')
      .bind(KEY_CHUNK_LOCK)
      .first();
    if (!row?.value) return null;
    const t = new Date(row.value).getTime();
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Lepas lock zombie (Worker kill / chunk hang) agar /tick tidak terblokir selamanya.
 * @param {import('@cloudflare/workers-types').D1Database} db
 */
export async function clearStaleChunkLock(db) {
  const lockAt = await getChunkLockTimestamp(db);
  if (lockAt == null) return false;

  const age = Date.now() - lockAt;
  if (age >= CHUNK_LOCK_TTL_MS) {
    await releaseChunkLock(db);
    return true;
  }

  return false;
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
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
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @returns {Promise<number | null>}
 */
export async function getChunkLockOffset(db) {
  try {
    const row = await db
      .prepare('SELECT value FROM sync_meta WHERE key = ?')
      .bind(KEY_CHUNK_LOCK_OFFSET)
      .first();
    if (row?.value == null) return null;
    const n = parseInt(row.value, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {number} [offset] offset yang sedang diproses (cegah /tick dobel)
 */
export async function tryAcquireChunkLock(db, offset) {
  await clearStaleChunkLock(db);
  if (await isChunkLocked(db)) return false;
  const now = new Date().toISOString();
  const statements = [
    db
      .prepare(
        `INSERT INTO sync_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .bind(KEY_CHUNK_LOCK, now),
  ];
  if (offset != null && Number.isFinite(offset)) {
    statements.push(
      db
        .prepare(
          `INSERT INTO sync_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        )
        .bind(KEY_CHUNK_LOCK_OFFSET, String(offset))
    );
  }
  await db.batch(statements);
  return true;
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 */
export async function releaseChunkLock(db) {
  try {
    await db.batch([
      db.prepare('DELETE FROM sync_meta WHERE key = ?').bind(KEY_CHUNK_LOCK),
      db.prepare('DELETE FROM sync_meta WHERE key = ?').bind(KEY_CHUNK_LOCK_OFFSET),
    ]);
  } catch {
    /* ignore */
  }
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {string} note
 */
export async function recordCronTick(db, note) {
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO sync_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .bind(KEY_SYNC_CRON_TICK, now),
    db
      .prepare(
        `INSERT INTO sync_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .bind(KEY_SYNC_CRON_NOTE, note),
  ]);
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 */
export async function getCronHeartbeat(db) {
  try {
    const { results } = await db
      .prepare(`SELECT key, value FROM sync_meta WHERE key IN (?, ?, ?)`)
      .bind(KEY_SYNC_CRON_TICK, KEY_SYNC_CRON_NOTE, KEY_SYNC_CRON_ENABLED)
      .all();
    const map = Object.fromEntries((results || []).map((r) => [r.key, r.value]));
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
 * @param {import('@cloudflare/workers-types').D1Database} db
 */
export async function markSyncRunStarted(db) {
  const now = new Date().toISOString();
  await setCronEnabled(db, true);
  await db.batch([
    db
      .prepare(
        `INSERT INTO sync_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .bind(KEY_SYNC_OFFSET, '0'),
    db
      .prepare(
        `INSERT INTO sync_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .bind(KEY_SYNC_STATE, 'running'),
    db
      .prepare(
        `INSERT INTO sync_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .bind(KEY_SYNC_CHUNK_AT, now),
  ]);
}
