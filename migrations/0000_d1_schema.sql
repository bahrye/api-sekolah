-- Skema tabel sekolah di Cloudflare D1 (SQLite)
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
  satuan_pendidikan_id TEXT,
  kode_wilayah TEXT,
  row_fp TEXT,
  migrated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sekolah_nama ON sekolah (nama);
CREATE INDEX IF NOT EXISTS idx_sekolah_kabupaten ON sekolah (nama_kabupaten);
CREATE INDEX IF NOT EXISTS idx_sekolah_row_fp_null ON sekolah (npsn) WHERE row_fp IS NULL OR row_fp = '';

-- Metadata sync + fingerprint halaman
CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_page_fp (
  page_index INTEGER PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Status sinkronisasi untuk tampilan publik (halaman utama)
CREATE TABLE IF NOT EXISTS status_sinkronisasi (
  id INTEGER PRIMARY KEY CHECK (id IN (1, 2)),
  waktu_selesai_terakhir TEXT,
  total_sekolah INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO status_sinkronisasi (id, waktu_selesai_terakhir, total_sekolah) VALUES (1, NULL, 0) ON CONFLICT(id) DO NOTHING;
INSERT INTO status_sinkronisasi (id, waktu_selesai_terakhir, total_sekolah) VALUES (2, NULL, 0) ON CONFLICT(id) DO NOTHING;
