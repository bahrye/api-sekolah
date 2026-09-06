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
    query = query.eq('npsn', cleanKeyword);
  } else if (/^\d+$/.test(cleanKeyword)) {
    // Prefix NPSN
    query = query.like('npsn', `${cleanKeyword}%`);
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
    if (/^\d+$/.test(cleanKeyword)) {
      query = query.like('npsn', `${cleanKeyword}%`);
    } else {
      query = query.ilike('nama', `%${cleanKeyword}%`);
    }
  }

  if (filters.provinsi) {
    const prov = filters.provinsi.trim();
    if (prov === 'LUAR NEGERI') {
      query = query.eq('nama_provinsi', 'LUAR NEGERI');
    } else if (prov.startsWith('LUAR NEGERI - ')) {
      const country = prov.replace('LUAR NEGERI - ', '').trim();
      query = query.eq('nama_provinsi', 'LUAR NEGERI').eq('nama_kabupaten', country);
    } else {
      query = query.eq('nama_provinsi', prov);
    }
  }

  if (filters.bentuk) {
    query = query.eq('bentuk_pendidikan', filters.bentuk.trim());
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
  const { data, error } = await supabase
    .from('status_sinkronisasi')
    .select('*')
    .eq('id', 1)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.warn('Gagal ambil status sinkronisasi:', error.message);
  }

  return {
    waktu_selesai_terakhir: data?.waktu_selesai_terakhir || new Date().toISOString(),
    waktu_selesai_terakhir_iso: data?.updated_at || new Date().toISOString(),
    total_sekolah: data?.total_sekolah || 553831,
  };
}
