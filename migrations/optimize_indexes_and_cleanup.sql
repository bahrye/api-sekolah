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
