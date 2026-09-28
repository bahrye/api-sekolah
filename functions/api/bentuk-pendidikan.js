import { getSupabase } from '../lib/db.js';
import { VALID_BENTUK } from '../lib/sync-supabase-core.js';

const normalizeCode = (str) => {
  if (!str) return '';
  return str.toLowerCase().trim().replace(/\s+/g, '-');
};

const normalizeName = (str) => {
  if (!str) return '';
  return str.toUpperCase().trim().replace(/-/g, ' ');
};

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const supabase = getSupabase(env);

  // GET: Mengambil seluruh bentuk pendidikan yang terdaftar
  if (request.method === 'GET') {
    try {
      // 1. Coba baca dari tabel bentuk_pendidikan di Supabase
      const { data: dbRows, error: dbErr } = await supabase
        .from('bentuk_pendidikan')
        .select('*')
        .eq('is_queryable', true)
        .order('nama');

      if (!dbErr && dbRows && dbRows.length > 0) {
        const codes = dbRows.map(r => r.kode);
        return new Response(JSON.stringify({ ok: true, data: codes, details: dbRows, source: 'table' }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }

      // 2. Fallback: baca dari tabel cache_data key 'bentuk_pendidikan_list'
      const { data: cacheRow } = await supabase
        .from('cache_data')
        .select('value')
        .eq('key', 'bentuk_pendidikan_list')
        .maybeSingle();

      if (cacheRow?.value) {
        const list = JSON.parse(cacheRow.value);
        if (Array.isArray(list) && list.length > 0) {
          return new Response(JSON.stringify({ ok: true, data: list, source: 'cache_data' }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          });
        }
      }

      // 3. Fallback baseline: gunakan VALID_BENTUK
      return new Response(JSON.stringify({ ok: true, data: VALID_BENTUK, source: 'default_baseline' }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: true, data: VALID_BENTUK, source: 'fallback_error', error: e.message }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  }

  // Verifikasi otentikasi untuk method yang mengubah data (POST, DELETE)
  const secret = url.searchParams.get('secret') || request.headers.get('x-cron-secret');
  const validSecret = env.CRON_SECRET || env.SYNC_SECRET || process.env?.CRON_SECRET || process.env?.SYNC_SECRET;

  if (!validSecret || secret !== validSecret) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // POST: Menambahkan atau memperbarui bentuk pendidikan baru
  if (request.method === 'POST') {
    try {
      const body = await request.json().catch(() => ({}));
      const rawBentuk = body.bentuk || body.kode;
      if (!rawBentuk) {
        return new Response(JSON.stringify({ ok: false, error: 'Parameter "bentuk" wajib disertakan.' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const kode = normalizeCode(rawBentuk);
      const nama = body.nama ? normalizeName(body.nama) : normalizeName(rawBentuk);
      const kategori = body.kategori || 'UMUM';
      const isQueryable = body.is_queryable !== false;

      // 1. Simpan ke tabel bentuk_pendidikan (jika tabel ada)
      try {
        await supabase.from('bentuk_pendidikan').upsert({
          kode,
          nama,
          kategori,
          is_queryable: isQueryable,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'kode' });
      } catch (errTable) {}

      // 2. Simpan ke cache_data key 'bentuk_pendidikan_list'
      try {
        let currentList = [];
        const { data: cacheRow } = await supabase
          .from('cache_data')
          .select('value')
          .eq('key', 'bentuk_pendidikan_list')
          .maybeSingle();

        if (cacheRow?.value) {
          try { currentList = JSON.parse(cacheRow.value); } catch (e) {}
        }
        if (!Array.isArray(currentList) || currentList.length === 0) {
          currentList = [...VALID_BENTUK];
        }

        if (isQueryable && !currentList.includes(kode)) {
          currentList.push(kode);
        } else if (!isQueryable) {
          currentList = currentList.filter(k => k !== kode);
        }

        await supabase.from('cache_data').upsert({
          key: 'bentuk_pendidikan_list',
          value: JSON.stringify(Array.from(new Set(currentList))),
          updated_at: new Date().toISOString(),
        });
      } catch (errCache) {}

      console.log(`[BENTUK-PENDIDIKAN] Bentuk pendidikan berhasil didaftarkan: ${kode} (${nama})`);

      return new Response(JSON.stringify({
        ok: true,
        message: `Bentuk pendidikan "${kode}" berhasil disimpan ke database.`,
        data: { kode, nama, kategori, is_queryable: isQueryable }
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // DELETE: Menandai bentuk pendidikan tidak valid / non-queryable
  if (request.method === 'DELETE') {
    try {
      const body = await request.json().catch(() => ({}));
      const rawBentuk = body.bentuk || body.kode;
      if (!rawBentuk) {
        return new Response(JSON.stringify({ ok: false, error: 'Parameter "bentuk" wajib disertakan.' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const kode = normalizeCode(rawBentuk);

      // 1. Update di tabel bentuk_pendidikan (jika ada)
      try {
        await supabase
          .from('bentuk_pendidikan')
          .update({ is_queryable: false, updated_at: new Date().toISOString() })
          .eq('kode', kode);
      } catch (errTable) {}

      // 2. Hapus dari cache_data key 'bentuk_pendidikan_list'
      try {
        const { data: cacheRow } = await supabase
          .from('cache_data')
          .select('value')
          .eq('key', 'bentuk_pendidikan_list')
          .maybeSingle();

        if (cacheRow?.value) {
          const currentList = JSON.parse(cacheRow.value);
          if (Array.isArray(currentList)) {
            const filtered = currentList.filter(k => k !== kode);
            await supabase.from('cache_data').upsert({
              key: 'bentuk_pendidikan_list',
              value: JSON.stringify(filtered),
              updated_at: new Date().toISOString(),
            });
          }
        }
      } catch (errCache) {}

      console.log(`[BENTUK-PENDIDIKAN] Bentuk pendidikan dinonaktifkan: ${kode}`);

      return new Response(JSON.stringify({
        ok: true,
        message: `Bentuk pendidikan "${kode}" berhasil dinonaktifkan dari daftar queryable.`
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' },
  });
}
