-- ===================================================================
-- Stored Procedure Pembersihan Sekolah Non-Aktif (Dihapus dari Sumber Data)
-- Jalankan di: Dashboard Supabase -> SQL Editor -> New query -> Run
-- ===================================================================

CREATE OR REPLACE FUNCTION public.fn_clean_inactive_sekolah(
  p_nama_provinsi TEXT,
  p_active_npsns TEXT[]
) RETURNS INT AS $$
DECLARE
  deleted_count INT;
  clean_prov TEXT;
BEGIN
  -- Bersihkan awalan PROV. untuk pencocokan fleksibel
  clean_prov := REGEXP_REPLACE(p_nama_provinsi, '^(PROVINSI|PROV\.?)\s*', '', 'i');

  WITH deleted AS (
    DELETE FROM public.sekolah
    WHERE (nama_provinsi ILIKE ('%' || clean_prov || '%'))
      AND npsn IS NOT NULL
      AND npsn <> ''
      AND npsn NOT IN (SELECT UNNEST(p_active_npsns))
    RETURNING 1
  )
  SELECT COUNT(*) INTO deleted_count FROM deleted;

  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Berikan izin eksekusi ke service_role, anon, authenticated
GRANT EXECUTE ON FUNCTION public.fn_clean_inactive_sekolah(TEXT, TEXT[]) TO anon, authenticated, service_role;
