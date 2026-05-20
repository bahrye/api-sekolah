-- Status sinkronisasi untuk tampilan publik (halaman utama)
CREATE TABLE IF NOT EXISTS status_sinkronisasi (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  waktu_selesai_terakhir TIMESTAMPTZ,
  total_sekolah INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE status_sinkronisasi ADD COLUMN IF NOT EXISTS waktu_selesai_terakhir TIMESTAMPTZ;
ALTER TABLE status_sinkronisasi ADD COLUMN IF NOT EXISTS total_sekolah INTEGER;
ALTER TABLE status_sinkronisasi ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

INSERT INTO status_sinkronisasi (id, waktu_selesai_terakhir, total_sekolah)
SELECT 1, NULL, COUNT(*)::int FROM sekolah
ON CONFLICT (id) DO NOTHING;

UPDATE status_sinkronisasi s
SET
  waktu_selesai_terakhir = COALESCE(
    s.waktu_selesai_terakhir,
    (SELECT value::timestamptz FROM sync_meta WHERE key = 'last_sync_at' LIMIT 1)
  ),
  total_sekolah = COALESCE(s.total_sekolah, (SELECT COUNT(*)::int FROM sekolah))
WHERE s.id = 1;
