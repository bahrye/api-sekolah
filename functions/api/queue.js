import { getSupabase } from '../lib/db.js';
import { getSessionFromRequest } from '../lib/auth.js';

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method.toUpperCase();

  // 1. Verifikasi Autentikasi Admin
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ ok: false, error: 'Sesi Anda telah berakhir. Silakan login kembali.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabase = getSupabase(env);

  if (method === 'GET') {
    try {
      const { data: qRow } = await supabase
        .from('cache_data')
        .select('value, updated_at')
        .eq('key', 'sync_queue')
        .maybeSingle();

      let queue = [];
      if (qRow && qRow.value) {
        try {
          queue = JSON.parse(qRow.value);
        } catch (e) {
          queue = [];
        }
      }

      return new Response(JSON.stringify({ ok: true, queue }), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  if (method === 'POST') {
    try {
      const body = await request.json().catch(() => ({}));
      const action = body.action || 'add';
      const provinsi = (body.provinsi || '').trim();
      const mulaiDariAwal = Boolean(body.mulai_dari_awal);

      // Ambil antrean saat ini
      const { data: qRow } = await supabase
        .from('cache_data')
        .select('value')
        .eq('key', 'sync_queue')
        .maybeSingle();

      let queue = [];
      if (qRow && qRow.value) {
        try {
          queue = JSON.parse(qRow.value);
        } catch (e) {
          queue = [];
        }
      }

      const cleanProv = (p) => (p || '').replace(/[^A-Z0-9]/gi, '').toUpperCase().replace(/^PROVINSI|^PROV/, '');

      if (action === 'add') {
        if (!provinsi) {
          return new Response(JSON.stringify({ ok: false, error: 'Nama provinsi wajib disertakan.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const cleanTarget = cleanProv(provinsi);
        const existingIdx = queue.findIndex(item => cleanProv(item.provinsi) === cleanTarget);

        if (existingIdx !== -1) {
          queue[existingIdx].mulai_dari_awal = mulaiDariAwal;
          queue[existingIdx].updated_at = new Date().toISOString();
        } else {
          queue.push({
            provinsi,
            mulai_dari_awal: mulaiDariAwal,
            added_at: new Date().toISOString(),
          });
        }

        await supabase.from('cache_data').upsert({
          key: 'sync_queue',
          value: JSON.stringify(queue),
          updated_at: new Date().toISOString(),
        });

        const queueIndex = queue.findIndex(item => cleanProv(item.provinsi) === cleanTarget) + 1;

        return new Response(
          JSON.stringify({
            ok: true,
            message: `Provinsi ${provinsi} berhasil ditambahkan ke antrean (#${queueIndex}).`,
            queue_index: queueIndex,
            queue,
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (action === 'remove') {
        if (!provinsi) {
          return new Response(JSON.stringify({ ok: false, error: 'Nama provinsi wajib disertakan.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const cleanTarget = cleanProv(provinsi);
        const beforeLen = queue.length;
        queue = queue.filter(item => cleanProv(item.provinsi) !== cleanTarget);

        if (queue.length === beforeLen) {
          return new Response(JSON.stringify({ ok: true, message: 'Provinsi tidak ditemukan di antrean.', queue }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        await supabase.from('cache_data').upsert({
          key: 'sync_queue',
          value: JSON.stringify(queue),
          updated_at: new Date().toISOString(),
        });

        return new Response(
          JSON.stringify({
            ok: true,
            message: `Antrean untuk provinsi ${provinsi} berhasil dibatalkan.`,
            queue,
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (action === 'clear') {
        queue = [];
        await supabase.from('cache_data').upsert({
          key: 'sync_queue',
          value: JSON.stringify(queue),
          updated_at: new Date().toISOString(),
        });

        return new Response(
          JSON.stringify({ ok: true, message: 'Seluruh antrean berhasil dikosongkan.', queue: [] }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(JSON.stringify({ ok: false, error: 'Aksi tidak dikenali.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      console.error('Error in queue API:', err);
      return new Response(JSON.stringify({ ok: false, error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' },
  });
}
