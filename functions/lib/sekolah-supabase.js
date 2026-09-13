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

function getNextPrefix(prefix) {
  if (!prefix) return null;
  const lastChar = prefix.charCodeAt(prefix.length - 1);
  return prefix.slice(0, -1) + String.fromCharCode(lastChar + 1);
}

export async function listSekolahSupabase(supabase, limit = 20, offset = 0) {
  const safeLimit = Math.min(Math.max(1, limit), 20);
  const { data, error } = await supabase
    .from('sekolah')
    .select('*')
    .order('npsn', { ascending: true })
    .range(offset, offset + safeLimit - 1);

  if (error) throw error;
  return data || [];
}

export async function searchSekolahSupabase(supabase, keyword, limit = 20, offset = 0) {
  const cleanKeyword = keyword?.trim() || '';
  if (!cleanKeyword) return [];

  const safeLimit = Math.min(Math.max(1, limit), 20);

  // 1. Exact NPSN match: menggunakan Primary Key (sangat instan < 1ms)
  if (/^\d{8}$/.test(cleanKeyword) || /^[Pp]\d{7}$/.test(cleanKeyword)) {
    const { data, error } = await supabase
      .from('sekolah')
      .select('*')
      .eq('npsn', cleanKeyword.toUpperCase())
      .limit(1);
    if (error) throw error;
    return data || [];
  }

  let query = supabase.from('sekolah').select('*');

  // 2. Prefix NPSN: Gunakan B-Tree range scan (GTE & LT) agar instan memanfaatkan Primary Key index
  if (/^\d+$/.test(cleanKeyword) || /^[Pp]\d+$/.test(cleanKeyword)) {
    const upper = cleanKeyword.toUpperCase();
    const nextPrefix = getNextPrefix(upper);
    query = query
      .gte('npsn', upper)
      .lt('npsn', nextPrefix)
      .order('npsn', { ascending: true })
      .range(offset, offset + safeLimit - 1);
  } else {
    // 3. Pencarian Nama Sekolah (Trigram GIN index)
    // Hindari order('npsn') agar PostgreSQL tidak mengabaikan GIN index dan melakukan sequential table scan
    query = query
      .ilike('nama', `%${cleanKeyword}%`)
      .range(offset, offset + safeLimit - 1);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function listSekolahFilteredSupabase(supabase, filters, limit = 20, offset = 0) {
  const safeLimit = Math.min(Math.max(1, limit), 20);
  let query = supabase.from('sekolah').select('*');

  if (filters.keyword) {
    const cleanKeyword = filters.keyword.trim();
    if (/^\d{8}$/.test(cleanKeyword) || /^[Pp]\d{7}$/.test(cleanKeyword)) {
      query = query.eq('npsn', cleanKeyword.toUpperCase());
    } else if (/^\d+$/.test(cleanKeyword) || /^[Pp]\d+$/.test(cleanKeyword)) {
      const upper = cleanKeyword.toUpperCase();
      const nextPrefix = getNextPrefix(upper);
      query = query.gte('npsn', upper).lt('npsn', nextPrefix);
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

  // Jika pencarian nama bebas, hindari order('npsn') agar GIN index tetap efektif
  const isNameSearch = filters.keyword && !/^\d+$/.test(filters.keyword.trim()) && !/^[Pp]\d+$/i.test(filters.keyword.trim());
  if (!isNameSearch) {
    query = query.order('npsn', { ascending: true });
  }

  const { data, error } = await query.range(offset, offset + safeLimit - 1);

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

  // Ambil total sekolah yang tersimpan di status_sinkronisasi (sangat instan tanpa scan 555rb+ baris tabel sekolah)
  let totalSekolah = active?.total_sekolah || row1?.total_sekolah;
  if (!totalSekolah || totalSekolah <= 0) {
    try {
      const { count, error: countErr } = await supabase
        .from('sekolah')
        .select('*', { count: 'exact', head: true });
      if (!countErr && count && count > 0) {
        totalSekolah = count;
      }
    } catch (e) {}
  }
  if (!totalSekolah || totalSekolah <= 0) {
    totalSekolah = 555670;
  }

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
