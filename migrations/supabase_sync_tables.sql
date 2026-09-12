-- ===================================================================
-- Skema Tabel Pendukung Sinkronisasi Otomatis (Dashboard Sync) di Supabase
-- ===================================================================

-- 1. Penyesuaian tabel status_sinkronisasi
ALTER TABLE public.status_sinkronisasi 
  ADD COLUMN IF NOT EXISTS bentuk_aktif TEXT DEFAULT 'tk',
  ADD COLUMN IF NOT EXISTS offset_terakhir INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_baru INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_diperbarui INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_tidak_berubah INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_dihapus INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_estimasi INT DEFAULT 553831,
  ADD COLUMN IF NOT EXISTS total_tanpa_npsn INT DEFAULT 0;

-- Pastikan record id=1 dan id=2 tersedia
INSERT INTO public.status_sinkronisasi (id, bentuk_aktif, offset_terakhir, total_sekolah, total_estimasi)
VALUES 
  (1, 'tk', 0, 553831, 553831),
  (2, 'Semua', 0, 553831, 553831)
ON CONFLICT (id) DO UPDATE SET
  total_estimasi = EXCLUDED.total_estimasi;

-- 2. Status per Provinsi
CREATE TABLE IF NOT EXISTS public.provinsi_sync_status (
  nama_provinsi TEXT PRIMARY KEY,
  terakhir_sukses TIMESTAMPTZ,
  api_duplicates INT DEFAULT 0,
  api_empty_npsn INT DEFAULT 0,
  api_unrecognized_shapes INT DEFAULT 0
);

-- 3. Cache Data (Perbandingan API vs Database)
CREATE TABLE IF NOT EXISTS public.cache_data (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Log Aktivitas Sinkronisasi Provinsi
CREATE TABLE IF NOT EXISTS public.log_aktivitas_provinsi (
  id BIGSERIAL PRIMARY KEY,
  nama_provinsi TEXT,
  total_baru INT DEFAULT 0,
  total_diperbarui INT DEFAULT 0,
  total_dihapus INT DEFAULT 0,
  total_tidak_berubah INT DEFAULT 0,
  total_non_queryable INT DEFAULT 0,
  waktu_selesai TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_log_waktu ON public.log_aktivitas_provinsi (waktu_selesai);

-- 5. Detail NPSN Ganda jika ada anomali sumber data
CREATE TABLE IF NOT EXISTS public.npsn_ganda_detail (
  npsn TEXT,
  nama_provinsi TEXT,
  sekolah_detail TEXT,
  PRIMARY KEY (npsn, nama_provinsi)
);

-- 6. Row Level Security & Hak Akses
ALTER TABLE public.provinsi_sync_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cache_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.log_aktivitas_provinsi ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.npsn_ganda_detail ENABLE ROW LEVEL SECURITY;

-- Policy Read Publik
DROP POLICY IF EXISTS "Public read provinsi_sync_status" ON public.provinsi_sync_status;
CREATE POLICY "Public read provinsi_sync_status" ON public.provinsi_sync_status FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Public read cache_data" ON public.cache_data;
CREATE POLICY "Public read cache_data" ON public.cache_data FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Public read log_aktivitas_provinsi" ON public.log_aktivitas_provinsi;
CREATE POLICY "Public read log_aktivitas_provinsi" ON public.log_aktivitas_provinsi FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Public read npsn_ganda_detail" ON public.npsn_ganda_detail;
CREATE POLICY "Public read npsn_ganda_detail" ON public.npsn_ganda_detail FOR SELECT TO anon, authenticated USING (true);

-- Policy Full Access Service Role
DROP POLICY IF EXISTS "Service role all provinsi_sync_status" ON public.provinsi_sync_status;
CREATE POLICY "Service role all provinsi_sync_status" ON public.provinsi_sync_status FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role all cache_data" ON public.cache_data;
CREATE POLICY "Service role all cache_data" ON public.cache_data FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role all log_aktivitas_provinsi" ON public.log_aktivitas_provinsi;
CREATE POLICY "Service role all log_aktivitas_provinsi" ON public.log_aktivitas_provinsi FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role all npsn_ganda_detail" ON public.npsn_ganda_detail;
CREATE POLICY "Service role all npsn_ganda_detail" ON public.npsn_ganda_detail FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Grants
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
