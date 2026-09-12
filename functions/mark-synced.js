import { getSupabase } from './lib/db.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const secret = url.searchParams.get('secret') || request.headers.get('x-cron-secret');
  const validSecret = env.CRON_SECRET || env.SYNC_SECRET || process.env?.CRON_SECRET || process.env?.SYNC_SECRET;

  if (!validSecret || secret !== validSecret) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabase = getSupabase(env);
    const body = await request.json();

    if (body.provinsiList && Array.isArray(body.provinsiList)) {
      const records = body.provinsiList.map((p) => {
        if (typeof p === 'object' && p.nama) {
          return {
            nama_provinsi: p.nama,
            terakhir_sukses: new Date().toISOString(),
            api_duplicates: p.api_duplicates || 0,
            api_empty_npsn: p.api_empty_npsn || 0,
          };
        }
        return {
          nama_provinsi: String(p),
          terakhir_sukses: new Date().toISOString(),
          api_duplicates: 0,
          api_empty_npsn: 0,
        };
      });

      await supabase
        .from('provinsi_sync_status')
        .upsert(records, { onConflict: 'nama_provinsi' });
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
