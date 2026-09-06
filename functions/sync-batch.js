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
    const { dataList, bentukAktif, offset, isFinished, customSync, ...customParams } = body;

    let stats = { baru: 0, diperbarui: 0, tidakBerubah: 0, tanpaNpsn: 0 };
    if (dataList && dataList.length > 0) {
      stats = await syncBatchToSupabase(supabase, dataList);
    }

    const isCustom = Boolean(customSync);
    const targetId = isCustom ? 2 : 1;

    // Format nama bentuk aktif dan nama provinsi
    const baseBentuk = (bentukAktif || 'tk').toUpperCase();
    const displayBentuk = (body.namaProvinsi && body.namaProvinsi !== 'SEMUA')
      ? `${baseBentuk} (${body.namaProvinsi})`
      : baseBentuk;

    // Ambil status saat ini
    const { data: currentStatus } = await supabase
      .from('status_sinkronisasi')
      .select('*')
      .eq('id', targetId)
      .single();

    let totalBaru = stats.baru;
    let totalDiperbarui = stats.diperbarui;
    let totalTidakBerubah = stats.tidakBerubah;
    let totalTanpaNpsn = stats.tanpaNpsn;
    let totalEstimasi = customParams.totalEstimasi || 0;

    if (isCustom) {
      if (!body.isStart && currentStatus) {
        totalBaru += (currentStatus.total_baru || 0);
        totalDiperbarui += (currentStatus.total_diperbarui || 0);
        totalTidakBerubah += (currentStatus.total_tidak_berubah || 0);
        totalTanpaNpsn += (currentStatus.total_tanpa_npsn || 0);
        totalEstimasi = customParams.totalEstimasi || currentStatus.total_estimasi || 0;
      }
    } else {
      const isReset = (bentukAktif === 'tk' || bentukAktif === 'ALL') && offset === 0;
      if (!isReset && currentStatus) {
        totalBaru += (currentStatus.total_baru || 0);
        totalDiperbarui += (currentStatus.total_diperbarui || 0);
        totalTidakBerubah += (currentStatus.total_tidak_berubah || 0);
        totalTanpaNpsn += (currentStatus.total_tanpa_npsn || 0);
      }
      totalEstimasi = 553831;
    }

    // Update status di Supabase
    await supabase.from('status_sinkronisasi').upsert({
      id: targetId,
      bentuk_aktif: displayBentuk,
      offset_terakhir: offset || 0,
      total_baru: totalBaru,
      total_diperbarui: totalDiperbarui,
      total_tidak_berubah: totalTidakBerubah,
      total_tanpa_npsn: totalTanpaNpsn,
      total_estimasi: totalEstimasi,
      updated_at: new Date().toISOString(),
      waktu_selesai_terakhir: isFinished ? new Date().toISOString() : (currentStatus?.waktu_selesai_terakhir || null),
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
