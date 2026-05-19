import { formatSyncTimeWib } from './sync-meta.js';
import { progressPercent } from './sync-sekolah.js';

const KEY_ACTIVITY_LOG = 'sync_activity_log';
const MAX_LINES = 8;

/** @typedef {'chunk' | 'cron_tick' | 'cron_skip' | 'cron_run' | 'cron_error' | 'backfill'} ActivityKind */

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 */
export async function getActivityLog(db) {
  try {
    const row = await db
      .prepare('SELECT value FROM sync_meta WHERE key = ?')
      .bind(KEY_ACTIVITY_LOG)
      .first();
    if (!row?.value) return [];
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * @param {{ offsetFrom: number, offsetTo: number, stats: object, note?: string }} entry
 */
export function formatActivityText({ offsetFrom, offsetTo, stats, note }) {
  const pct = progressPercent(offsetTo);
  const parts = [];
  if (stats.scanned) parts.push(`baca ${stats.scanned}`);
  if (stats.inserted) parts.push(`tambah ${stats.inserted}`);
  if (stats.updated) parts.push(`ubah ${stats.updated}`);
  if (stats.skipped) parts.push(`lewati ${stats.skipped}`);
  if (stats.row_fp_backfill) parts.push(`isi_fp ${stats.row_fp_backfill}`);
  if (stats.pages_fp_skip) parts.push(`fp_skip ${stats.pages_fp_skip}`);
  if (stats.pages) parts.push(`${stats.pages} hal`);

  const detail = parts.length ? parts.join(' · ') : 'tidak ada perubahan';
  const prefix = note ? `${note}: ` : '';
  return `${prefix}offset ${offsetFrom.toLocaleString('id-ID')}→${offsetTo.toLocaleString('id-ID')} (${pct}%) · ${detail}`;
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {object} line
 */
async function pushActivityLine(db, line) {
  const existing = await getActivityLog(db);
  const next = [line, ...existing].slice(0, MAX_LINES);

  await db
    .prepare(
      `INSERT INTO sync_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .bind(KEY_ACTIVITY_LOG, JSON.stringify(next))
    .run();

  return next;
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {{ offsetFrom: number, offsetTo: number, stats: object, note?: string }} entry
 */
export async function appendActivityLog(db, entry) {
  const ts = new Date().toISOString();
  const text = formatActivityText(entry);
  const line = {
    ts,
    wib: formatSyncTimeWib(ts),
    kind: 'chunk',
    text,
    offset_from: entry.offsetFrom,
    offset_to: entry.offsetTo,
    scanned: entry.stats.scanned ?? 0,
    inserted: entry.stats.inserted ?? 0,
    updated: entry.stats.updated ?? 0,
    skipped: entry.stats.skipped ?? 0,
    row_fp_backfill: entry.stats.row_fp_backfill ?? 0,
    pages_fp_skip: entry.stats.pages_fp_skip ?? 0,
    pages: entry.stats.pages ?? 0,
    max_pages: entry.stats.max_pages ?? entry.stats.pages ?? 0,
    timed_out: entry.stats.timed_out === true,
  };

  const existing = await getActivityLog(db);
  const head = existing[0];
  if (
    head?.kind === 'chunk' &&
    head.offset_from === entry.offsetFrom &&
    head.offset_to === entry.offsetTo
  ) {
    const merged = [line, ...existing.slice(1)].slice(0, MAX_LINES);
    await db
      .prepare(
        `INSERT INTO sync_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .bind(KEY_ACTIVITY_LOG, JSON.stringify(merged))
      .run();
    return merged;
  }

  return pushActivityLine(db, line);
}

const SKIP_LABELS = {
  completed: 'data sudah 100%',
  cron_disabled: 'cron nonaktif — panggil /run',
  idle: 'status idle — panggil /run',
  chunk_in_progress: 'chunk sebelumnya masih berjalan',
  lock_cleared: 'lock macet dibersihkan, melanjutkan',
};

/**
 * Log panggilan Cron (/tick lewati, /run mulai, gagal, dll.).
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {{ kind: ActivityKind, action: string, detail?: string, offset?: number, apiTotal?: number }} opts
 */
export async function appendCronJobActivityLog(db, { kind, action, detail, offset, apiTotal }) {
  const ts = new Date().toISOString();
  let text = detail ?? action;

  const src = detail && detail.startsWith('Cloudflare') ? '' : 'Cron ';
  if (kind === 'cron_tick' && offset != null) {
    const pct = apiTotal ? progressPercent(offset) : null;
    const pctStr = pct != null ? ` (${pct}%)` : '';
    text = `${src}/tick · ${detail || 'chunk dijadwalkan'} @ offset ${offset.toLocaleString('id-ID')}${pctStr}`;
  } else if (kind === 'cron_skip') {
    const label = SKIP_LABELS[action] ?? action;
    text = `${src}/tick · lewati (${label})`;
  } else if (kind === 'cron_run') {
    const o = offset ?? 0;
    text = `${src}/run · ${detail || 'sinkronisasi dimulai'} @ offset ${o.toLocaleString('id-ID')}`;
  } else if (kind === 'cron_error') {
    text = `Cron · gagal — ${detail || action}`;
  } else if (!detail) {
    text = `Cron · ${action}`;
  }

  const line = {
    ts,
    wib: formatSyncTimeWib(ts),
    kind,
    text,
    action,
    offset: offset ?? null,
  };

  return pushActivityLine(db, line);
}

/**
 * Log backfill row_fp di daftar aktivitas (sama dengan log Cron).
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {{ action: string, detail: string, processed?: number, null_remaining?: number | null }} opts
 */
export async function appendBackfillActivityLog(db, { action, detail, processed, null_remaining }) {
  const ts = new Date().toISOString();
  const parts = [detail];
  if (processed != null && processed > 0) {
    parts.push(`proses ${processed.toLocaleString('id-ID')}`);
  }
  if (null_remaining != null) {
    parts.push(`sisa ~${null_remaining.toLocaleString('id-ID')}`);
  }

  const line = {
    ts,
    wib: formatSyncTimeWib(ts),
    kind: 'backfill',
    text: `Backfill row_fp · ${parts.join(' · ')}`,
    action,
    processed: processed ?? null,
    null_remaining: null_remaining ?? null,
  };

  return pushActivityLine(db, line);
}

/**
 * @param {ActivityKind} kind
 */
export function activityKindLabel(kind) {
  if (kind === 'chunk') return 'Chunk data';
  if (kind === 'backfill') return 'Backfill row_fp';
  if (kind === 'cron_tick') return 'Cron /tick';
  if (kind === 'cron_skip') return 'Cron /tick';
  if (kind === 'cron_run') return 'Cron /run';
  if (kind === 'cron_error') return 'Error';
  return 'Aktivitas';
}
