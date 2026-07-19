-- Migration: add_indexes_provinsi_bentuk
CREATE INDEX IF NOT EXISTS idx_sekolah_provinsi ON sekolah (nama_provinsi);
CREATE INDEX IF NOT EXISTS idx_sekolah_bentuk ON sekolah (bentuk_pendidikan);
