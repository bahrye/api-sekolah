-- ===================================================================
-- Skrip Optimasi Indeks & Sinkronisasi Metadata Supabase
-- Jalankan skrip ini di: Dashboard Supabase -> SQL Editor -> New query -> Run
-- ===================================================================

-- 1. Composite Index untuk mempercepat query filter provinsi + ORDER BY npsn (< 20ms)
-- Sebelumnya query ini memakan waktu 7+ detik (risiko HTTP 524 Timeout di Cloudflare Pages)
CREATE INDEX IF NOT EXISTS idx_sekolah_provinsi_npsn ON public.sekolah (nama_provinsi, npsn);

-- 2. Composite Index untuk query filter bentuk pendidikan + ORDER BY npsn
CREATE INDEX IF NOT EXISTS idx_sekolah_bentuk_npsn ON public.sekolah (bentuk_pendidikan, npsn);

-- 3. Index untuk tabel detail duplikat NPSN
CREATE INDEX IF NOT EXISTS idx_npsn_ganda_prov ON public.npsn_ganda_detail (nama_provinsi);

-- 4. Sinkronkan total_sekolah & total_estimasi dengan jumlah baris riil di database
UPDATE public.status_sinkronisasi
SET
  total_sekolah = (SELECT COUNT(*) FROM public.sekolah),
  total_estimasi = (SELECT COUNT(*) FROM public.sekolah),
  updated_at = NOW()
WHERE id = 1;

-- 5. Tambahkan kolom total_db pada tabel provinsi_sync_status (untuk snapshot hitungan saat sinkronisasi)
ALTER TABLE public.provinsi_sync_status 
  ADD COLUMN IF NOT EXISTS total_db INT DEFAULT 0;

-- 6. View Rekap Total Sekolah Per Provinsi (Real-time agregat untuk Perbandingan Data Sumber vs DB)
CREATE OR REPLACE VIEW public.v_rekap_provinsi AS
SELECT 
  nama_provinsi,
  COUNT(*)::int AS total_sekolah
FROM public.sekolah
GROUP BY nama_provinsi;

-- Berikan izin akses baca view ke semua peran API Supabase
GRANT SELECT ON public.v_rekap_provinsi TO anon, authenticated, service_role;

-- 7. Aktifkan Supabase Realtime untuk pembaruan dashboard tanpa jeda (WebSockets)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'status_sinkronisasi'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.status_sinkronisasi;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'log_aktivitas_provinsi'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.log_aktivitas_provinsi;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'provinsi_sync_status'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.provinsi_sync_status;
  END IF;
END $$;

