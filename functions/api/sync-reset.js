import { getSupabase } from '../lib/db.js';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const secret = url.searchParams.get('secret') || request.headers.get('x-cron-secret');
  const proc = typeof process !== 'undefined' ? process.env : undefined;
  const validSecret = env.CRON_SECRET || env.SYNC_SECRET || proc?.CRON_SECRET || proc?.SYNC_SECRET;

  if (!validSecret || secret !== validSecret) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized: Masukkan parameter secret yang valid' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    const supabase = getSupabase(env);
    const now = new Date().toISOString();
    const resetData = {
      bentuk_aktif: 'Selesai',
      offset_terakhir: 0,
      total_baru: 0,
      total_diperbarui: 0,
      total_tidak_berubah: 0,
      total_tanpa_npsn: 0,
      total_estimasi: 0,
      updated_at: now,
      waktu_selesai_terakhir: now,
    };

    const { error: err2 } = await supabase
      .from('status_sinkronisasi')
      .update(resetData)
      .eq('id', 2);

    if (err2) throw err2;

    return new Response(JSON.stringify({ ok: true, message: 'Status sinkronisasi berhasil direset menjadi Selesai/Kosong.' }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
