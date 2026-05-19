-- Percepat SELECT ... WHERE row_fp IS NULL LIMIT N (opsional, jalankan sekali di D1)
CREATE INDEX IF NOT EXISTS idx_sekolah_row_fp_null ON sekolah (NPSN) WHERE row_fp IS NULL;
