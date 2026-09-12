import { formatSyncTimeWib } from './sync-meta.js';

/**
 * Implementasi query database Sekolah menggunakan Supabase (PostgreSQL)
 */

export async function countSekolahSupabase(supabase) {
  const { count, error } = await supabase
    .from('sekolah')
    .select('*', { count: 'exact', head: true });
  if (error) throw error;
  return count || 0;
}

export async function listSekolahSupabase(supabase, limit = 20, offset = 0) {
  const { data, error } = await supabase
    .from('sekolah')
    .select('*')
    .order('npsn', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return data || [];
}

export async function searchSekolahSupabase(supabase, keyword, limit = 20, offset = 0) {
  const cleanKeyword = keyword?.trim() || '';
  if (!cleanKeyword) return [];

  let query = supabase.from('sekolah').select('*');

  if (/^\d{8}$/.test(cleanKeyword) || /^[Pp]\d{7}$/.test(cleanKeyword)) {
    // Exact NPSN match: menggunakan Primary Key (sangat instan < 1ms)
    query = query.eq('npsn', cleanKeyword.toUpperCase());
  } else if (/^\d+$/.test(cleanKeyword) || /^[Pp]\d+$/.test(cleanKeyword)) {
    // Prefix NPSN
    query = query.like('npsn', `${cleanKeyword.toUpperCase()}%`);
  } else {
    // Pencarian Nama Sekolah (Fuzzy / Case-insensitive Trigram GIN index)
    query = query.ilike('nama', `%${cleanKeyword}%`);
  }

  const { data, error } = await query
    .order('npsn', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return data || [];
}

export async function listSekolahFilteredSupabase(supabase, filters, limit = 20, offset = 0) {
  let query = supabase.from('sekolah').select('*');

  if (filters.keyword) {
    const cleanKeyword = filters.keyword.trim();
    if (/^\d+$/.test(cleanKeyword) || /^[Pp]\d+$/.test(cleanKeyword)) {
      query = query.like('npsn', `${cleanKeyword.toUpperCase()}%`);
    } else {
      query = query.ilike('nama', `%${cleanKeyword}%`);
    }
  }

  if (filters.provinsi) {
    const rawProv = filters.provinsi.trim();
    if (rawProv.toUpperCase() === 'LUAR NEGERI') {
      query = query.eq('nama_provinsi', 'LUAR NEGERI');
    } else if (rawProv.toUpperCase().startsWith('LUAR NEGERI - ')) {
      const country = rawProv.substring(14).trim();
      query = query.eq('nama_provinsi', 'LUAR NEGERI').eq('nama_kabupaten', country);
    } else {
      const upperProv = rawProv.toUpperCase();
      const cleanProv = upperProv.replace(/^PROVINSI\s+|^PROV\.\s+|^PROV\s+/i, '').trim();
      const provVariants = [cleanProv, `PROV. ${cleanProv}`, `PROVINSI ${cleanProv}`];
      query = query.in('nama_provinsi', provVariants);
    }
  }

  if (filters.bentuk) {
    query = query.eq('bentuk_pendidikan', filters.bentuk.trim().toUpperCase());
  }

  const { data, error } = await query
    .order('npsn', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return data || [];
}

export async function getRekapSekolahSupabase(supabase) {
  // Mengambil rekap persebaran wilayah dan jenjang
  // Menggunakan RPC atau query SQL jika ada, atau fallback kalkulasi
  const { data, error } = await supabase
    .from('sekolah')
    .select('nama_provinsi, nama_kabupaten, bentuk_pendidikan');

  if (error) throw error;
  return data || [];
}

export async function getStatusSinkronisasiSupabase(supabase) {
  const { data: results, error } = await supabase
    .from('status_sinkronisasi')
    .select('*')
    .in('id', [1, 2]);

  if (error && error.code !== 'PGRST116') {
    console.warn('Gagal ambil status sinkronisasi:', error.message);
  }

  const row1 = results?.find((r) => r.id === 1);
  const row2 = results?.find((r) => r.id === 2);
  const active =
    row2 && row2.updated_at && (!row1 || new Date(row2.updated_at) > new Date(row1.updated_at))
      ? row2
      : row1 || row2;

  // Ambil jumlah real-time aktual dari tabel sekolah
  let totalSekolah = active?.total_sekolah || row1?.total_sekolah || 555008;
  try {
    const { count, error: countErr } = await supabase
      .from('sekolah')
      .select('*', { count: 'exact', head: true });
    if (!countErr && count && count > 0) {
      totalSekolah = count;
    }
  } catch (e) {}

  const latestIso = active?.updated_at || active?.waktu_selesai_terakhir || new Date().toISOString();
  let isRunning = false;
  if (active?.updated_at) {
    const t = new Date(active.updated_at).getTime();
    if (!isNaN(t) && (Date.now() - t < 120000)) {
      isRunning = true;
    }
  }

  return {
    waktu_selesai_terakhir: formatSyncTimeWib(latestIso),
    waktu_selesai_terakhir_iso: latestIso,
    total_sekolah: totalSekolah,
    is_running: isRunning,
    bentuk_aktif: active?.bentuk_aktif || null,
  };
}
