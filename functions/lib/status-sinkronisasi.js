import { formatSyncTimeWib } from './sync-meta.js';
import { countSekolah } from './sekolah-pg.js';
import { metaGet } from './pg-meta.js';

const KEY_LAST_SYNC = 'last_sync_at';

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 */
export async function recordSinkronisasiSelesai(sql) {
  const total = await countSekolah(sql);
  const now = new Date().toISOString();
  await sql`
    INSERT INTO status_sinkronisasi (id, waktu_selesai_terakhir, total_sekolah, updated_at)
    VALUES (2, ${now}, ${total}, NOW())
    ON CONFLICT (id) DO UPDATE SET
      waktu_selesai_terakhir = EXCLUDED.waktu_selesai_terakhir,
      total_sekolah = EXCLUDED.total_sekolah,
      updated_at = NOW()
  `;
}

/**
 * Metadata publik untuk halaman utama & GET /api/status
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 */
export async function getStatusSinkronisasiPublik(sql) {
  let waktuIso = null;
  let total = null;

  try {
    const rows = await sql`
      SELECT waktu_selesai_terakhir, total_sekolah
      FROM status_sinkronisasi
      WHERE id = 2
    `;
    const row = rows[0];
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
      const legacy = await metaGet(sql, KEY_LAST_SYNC);
      if (legacy) waktuIso = new Date(legacy.includes('T') ? legacy : legacy + 'Z').toISOString();
    } catch {
      /* ignore */
    }
  }

  if (total == null || !Number.isFinite(total)) {
    try {
      total = await countSekolah(sql);
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
