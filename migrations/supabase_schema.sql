-- ===================================================================
-- Skema Database Supabase (PostgreSQL) untuk EduAPI Indonesia
-- Jalankan skrip ini di: Dashboard Supabase -> SQL Editor -> New query -> Run
-- ===================================================================

-- 1. Ekstensi untuk pencarian teks cepat (Fuzzy / Trigram Search)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Buat tabel utama `sekolah`
CREATE TABLE IF NOT EXISTS public.sekolah (
  npsn VARCHAR(10) PRIMARY KEY,
  nama TEXT NOT NULL DEFAULT '',
  bentuk_pendidikan VARCHAR(50),
  bentuk_pendidikan_group VARCHAR(50),
  jenis_pendidikan VARCHAR(50),
  status_satuan_pendidikan VARCHAR(20),
  jenjang_pendidikan VARCHAR(50),
  pembina VARCHAR(100),
  jalur_pendidikan VARCHAR(50),
  nama_desa TEXT,
  nama_kecamatan TEXT,
  nama_kabupaten TEXT,
  nama_provinsi TEXT,
  alamat_jalan TEXT,
  row_fp TEXT,
  migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Indeks untuk optimasi pencarian & filter
CREATE INDEX IF NOT EXISTS idx_sekolah_provinsi ON public.sekolah (nama_provinsi);
CREATE INDEX IF NOT EXISTS idx_sekolah_bentuk ON public.sekolah (bentuk_pendidikan);
CREATE INDEX IF NOT EXISTS idx_sekolah_kabupaten ON public.sekolah (nama_kabupaten);
CREATE INDEX IF NOT EXISTS idx_sekolah_nama_trgm ON public.sekolah USING gin (nama gin_trgm_ops);

-- 4. Tabel rekap / status sinkronisasi
CREATE TABLE IF NOT EXISTS public.status_sinkronisasi (
  id INT PRIMARY KEY CHECK (id IN (1, 2)),
  waktu_selesai_terakhir TEXT,
  total_sekolah INT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.status_sinkronisasi (id, waktu_selesai_terakhir, total_sekolah)
VALUES (1, NOW()::TEXT, 553831)
ON CONFLICT (id) DO NOTHING;

-- 5. Konfigurasi Keamanan (Row Level Security - RLS)
ALTER TABLE public.sekolah ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.status_sinkronisasi ENABLE ROW LEVEL SECURITY;

-- Kebijakan: Publik (anon) hanya diizinkan BACA (SELECT)
DROP POLICY IF EXISTS "Public can read sekolah" ON public.sekolah;
CREATE POLICY "Public can read sekolah" ON public.sekolah
  FOR SELECT TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "Public can read status" ON public.status_sinkronisasi;
CREATE POLICY "Public can read status" ON public.status_sinkronisasi
  FOR SELECT TO anon, authenticated
  USING (true);

-- Kebijakan: Hanya service_role (Admin/Scraper) yang bisa INSERT, UPDATE, DELETE
DROP POLICY IF EXISTS "Service role full access sekolah" ON public.sekolah;
CREATE POLICY "Service role full access sekolah" ON public.sekolah
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access status" ON public.status_sinkronisasi;
CREATE POLICY "Service role full access status" ON public.status_sinkronisasi
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- 6. Hak Akses (GRANT Permissions) untuk API PostgREST
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
