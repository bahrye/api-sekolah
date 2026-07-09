import { formatSyncTimeWib } from './sync-meta.js';
import { countSekolah } from './sekolah-db.js';
import { metaGet } from './db-meta.js';

const KEY_LAST_SYNC = 'last_sync_at';

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 */
export async function recordSinkronisasiSelesai(db) {
  const total = await countSekolah(db);
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO status_sinkronisasi (id, waktu_selesai_terakhir, total_sekolah, updated_at)
    VALUES (2, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO UPDATE SET
      waktu_selesai_terakhir = excluded.waktu_selesai_terakhir,
      total_sekolah = excluded.total_sekolah,
      updated_at = CURRENT_TIMESTAMP
  `).bind(now, total).run();
}

/**
 * Metadata publik untuk halaman utama & GET /api/status
 * @param {import('@cloudflare/workers-types').D1Database} db
 */
export async function getStatusSinkronisasiPublik(db) {
  let waktuIso = null;
  let total = null;

  try {
    const row = await db.prepare(`
      SELECT waktu_selesai_terakhir, total_sekolah
      FROM status_sinkronisasi
      ORDER BY waktu_selesai_terakhir DESC
      LIMIT 1
    `).first();
    if (row?.waktu_selesai_terakhir) {
      waktuIso = new Date(row.waktu_selesai_terakhir).toISOString();
    }
    if (row?.total_sekolah != null) {
      total = Number(row.total_sekolah);
    }
  } catch {
    /* tabel belum ada */
  }

  if (!waktuIso) {
    try {
      const legacy = await metaGet(db, KEY_LAST_SYNC);
      if (legacy) waktuIso = new Date(legacy.includes('T') ? legacy : legacy + 'Z').toISOString();
    } catch {
      /* ignore */
    }
  }

  if (total == null || !Number.isFinite(total)) {
    try {
      total = await countSekolah(db);
    } catch {
      total = null;
    }
  }

  return {
    waktu_selesai_terakhir_iso: waktuIso,
    waktu_selesai_terakhir: waktuIso ? formatSyncTimeWib(waktuIso) : null,
    total_sekolah: Number.isFinite(total) ? total : null,
  };
}
