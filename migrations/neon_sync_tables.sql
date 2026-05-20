-- Metadata sync + fingerprint halaman (pindah dari D1)
CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_page_fp (
  page_index INTEGER PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sekolah ADD COLUMN IF NOT EXISTS row_fp TEXT;

CREATE INDEX IF NOT EXISTS idx_sekolah_row_fp_null ON sekolah (npsn) WHERE row_fp IS NULL OR row_fp = '';

-- Total awal dari data yang sudah dimigrasi
INSERT INTO sync_meta (key, value)
SELECT 'total_sekolah', COUNT(*)::text FROM sekolah
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
