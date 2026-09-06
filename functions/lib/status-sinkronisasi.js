import { formatSyncTimeWib } from './sync-meta.js';
import { countSekolah } from './sekolah-db.js';
import { metaGetMany } from './db-meta.js';

const KEY_LAST_SYNC = 'last_sync_at';
const KEY_TOTAL = 'total_sekolah';
const FALLBACK_TOTAL_SEKOLAH = 552578;

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 */
export async function recordSinkronisasiSelesai(db) {
  // Auto-fill missing province names using other schools in the same kabupaten
  try {
    await db.prepare(`
      UPDATE sekolah
      SET nama_provinsi = (
        SELECT s2.nama_provinsi
        FROM sekolah s2
        WHERE s2.nama_kabupaten = sekolah.nama_kabupaten
          AND s2.nama_provinsi IS NOT NULL
          AND s2.nama_provinsi != ''
        LIMIT 1
      )
      WHERE nama_provinsi IS NULL OR nama_provinsi = ''
    `).run();
  } catch {
    /* ignore */
  }

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
 * Metadata publik untuk halaman utama & GET /api/status.
 * Mengambil total_sekolah & waktu terakhir dari metadata (1 baris baca) tanpa COUNT(*) scan!
 * @param {import('@cloudflare/workers-types').D1Database} db
 */
export async function getStatusSinkronisasiPublik(db) {
  let waktuIso = null;
  let total = null;

  try {
    const row = await db.prepare(`
      SELECT waktu_selesai_terakhir, total_sekolah
      FROM status_sinkronisasi
      WHERE total_sekolah > 0 OR waktu_selesai_terakhir IS NOT NULL
      ORDER BY waktu_selesai_terakhir DESC
      LIMIT 1
    `).first();
    if (row) {
      if (row.waktu_selesai_terakhir) {
        waktuIso = new Date(row.waktu_selesai_terakhir).toISOString();
      }
      if (Number.isFinite(row.total_sekolah) && row.total_sekolah > 0) {
        total = row.total_sekolah;
      }
    }
  } catch {
    /* tabel belum ada */
  }

  if (!waktuIso || !total) {
    try {
      const legacyMap = await metaGetMany(db, [KEY_LAST_SYNC, KEY_TOTAL]);
      if (!waktuIso && legacyMap[KEY_LAST_SYNC]) {
        const legacy = legacyMap[KEY_LAST_SYNC];
        waktuIso = new Date(legacy.includes('T') ? legacy : legacy + 'Z').toISOString();
      }
      if (!total && legacyMap[KEY_TOTAL]) {
        const parsed = parseInt(legacyMap[KEY_TOTAL], 10);
        if (Number.isFinite(parsed) && parsed > 0) total = parsed;
      }
    } catch {
      /* ignore */
    }
  }

  return {
    waktu_selesai_terakhir_iso: waktuIso,
    waktu_selesai_terakhir: waktuIso ? formatSyncTimeWib(waktuIso) : null,
    total_sekolah: total || FALLBACK_TOTAL_SEKOLAH,
  };
}

