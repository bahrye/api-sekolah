import { getSupabase } from './lib/db.js';
import { syncBatchToSupabase } from './lib/sync-supabase-core.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const secret = url.searchParams.get('secret') || request.headers.get('x-cron-secret');
  const validSecret = env.CRON_SECRET || env.SYNC_SECRET || process.env?.CRON_SECRET || process.env?.SYNC_SECRET;

  if (validSecret && secret !== validSecret) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabase = getSupabase(env);
    const body = await request.json();
    const { dataList, bentukAktif, offset, isFinished, ...customParams } = body;

    let stats = { baru: 0, diperbarui: 0, tidakBerubah: 0, tanpaNpsn: 0 };
    if (dataList && dataList.length > 0) {
      stats = await syncBatchToSupabase(supabase, dataList);
    }

    const isReset = (bentukAktif === 'tk' || bentukAktif === 'ALL') && offset === 0;

    // Ambil status saat ini
    const { data: currentStatus } = await supabase
      .from('status_sinkronisasi')
      .select('*')
      .eq('id', 1)
      .single();

    const totalBaru = (isReset ? 0 : (currentStatus?.total_baru || 0)) + stats.baru;
    const totalDiperbarui = (isReset ? 0 : (currentStatus?.total_diperbarui || 0)) + stats.diperbarui;
    const totalTidakBerubah = (isReset ? 0 : (currentStatus?.total_tidak_berubah || 0)) + stats.tidakBerubah;
    const totalTanpaNpsn = (isReset ? 0 : (currentStatus?.total_tanpa_npsn || 0)) + stats.tanpaNpsn;

    // Update status di Supabase
    await supabase.from('status_sinkronisasi').upsert({
      id: 1,
      bentuk_aktif: bentukAktif || 'tk',
      offset_terakhir: offset || 0,
      total_baru: totalBaru,
      total_diperbarui: totalDiperbarui,
      total_tidak_berubah: totalTidakBerubah,
      total_tanpa_npsn: totalTanpaNpsn,
      updated_at: new Date().toISOString(),
      waktu_selesai_terakhir: isFinished ? new Date().toISOString() : currentStatus?.waktu_selesai_terakhir,
    });

    // Jika provinsi selesai, catat ke provinsi_sync_status & log_aktivitas_provinsi
    if (isFinished && body.namaProvinsi && body.namaProvinsi !== 'SEMUA') {
      try {
        await supabase.from('provinsi_sync_status').upsert({
          nama_provinsi: body.namaProvinsi,
          terakhir_sukses: new Date().toISOString(),
          api_duplicates: customParams.duplicates?.length || 0,
          api_empty_npsn: totalTanpaNpsn,
          api_unrecognized_shapes: customParams.unrecognized_shapes || 0,
        });

        await supabase.from('log_aktivitas_provinsi').insert({
          nama_provinsi: body.namaProvinsi,
          total_baru: stats.baru,
          total_diperbarui: stats.diperbarui,
          total_dihapus: 0,
          total_tidak_berubah: stats.tidakBerubah,
          waktu_selesai: new Date().toISOString(),
        });
      } catch (e) {
        console.warn('Gagal simpan log provinsi:', e.message);
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        stats,
        bentukAktif,
        offset,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ ok: false, error: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
