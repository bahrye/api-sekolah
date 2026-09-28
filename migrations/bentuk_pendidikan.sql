-- ===================================================================
-- Migrasi: Tabel Bentuk Pendidikan Dinamis (Supabase PostgreSQL)
-- Jalankan di: Supabase Dashboard -> SQL Editor -> New Query -> Run
-- ===================================================================

CREATE TABLE IF NOT EXISTS public.bentuk_pendidikan (
  kode TEXT PRIMARY KEY,
  nama TEXT NOT NULL,
  kategori TEXT,
  is_queryable BOOLEAN DEFAULT true,
  total_sekolah INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index pencarian
CREATE INDEX IF NOT EXISTS idx_bentuk_pendidikan_queryable ON public.bentuk_pendidikan (is_queryable);

-- Hak akses baca untuk publik (anon) dan service_role
GRANT SELECT ON public.bentuk_pendidikan TO anon, authenticated, service_role;
GRANT ALL ON public.bentuk_pendidikan TO service_role;
