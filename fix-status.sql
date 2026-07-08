INSERT INTO status_sinkronisasi (id, waktu_selesai_terakhir, total_sekolah, updated_at)
VALUES (2, CURRENT_TIMESTAMP, (SELECT COUNT(*) FROM sekolah), CURRENT_TIMESTAMP)
ON CONFLICT (id) DO UPDATE SET
  waktu_selesai_terakhir = excluded.waktu_selesai_terakhir,
  total_sekolah = excluded.total_sekolah,
  updated_at = CURRENT_TIMESTAMP;
