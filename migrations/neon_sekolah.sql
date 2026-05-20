-- Skema tabel sekolah di Neon (PostgreSQL)
CREATE TABLE IF NOT EXISTS sekolah (
  npsn TEXT PRIMARY KEY,
  nama TEXT NOT NULL DEFAULT '',
  bentuk_pendidikan TEXT,
  bentuk_pendidikan_group TEXT,
  jenis_pendidikan TEXT,
  status_satuan_pendidikan TEXT,
  jenjang_pendidikan TEXT,
  pembina TEXT,
  jalur_pendidikan TEXT,
  nama_desa TEXT,
  nama_kecamatan TEXT,
  nama_kabupaten TEXT,
  nama_provinsi TEXT,
  alamat_jalan TEXT,
  migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sekolah_nama ON sekolah (nama);
CREATE INDEX IF NOT EXISTS idx_sekolah_kabupaten ON sekolah (nama_kabupaten);
