import { getSupabase } from './lib/db.js';
import { syncBatchToSupabase } from './lib/sync-supabase-core.js';
const cleanName = (name) => {
  if (!name) return '';
  return name.replace(/[^A-Z0-9]/gi, '').toUpperCase().replace(/^PROVINSI|^PROV/, '');
};

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
      bentuk_aktif: isFinished && isCustom && bentukAktif === 'Selesai' ? 'Selesai' : displayBentuk,
      offset_terakhir: isFinished ? 0 : (offset || 0),
      total_baru: totalBaru,
      total_diperbarui: totalDiperbarui,
      total_tidak_berubah: totalTidakBerubah,
      total_tanpa_npsn: totalTanpaNpsn,
      total_estimasi: totalEstimasi,
      updated_at: new Date().toISOString(),
      waktu_selesai_terakhir: isFinished ? new Date().toISOString() : (currentStatus?.waktu_selesai_terakhir || null),
    });

    // Jika provinsi selesai, jalankan pembersihan data nonaktif, catat ke provinsi_sync_status, log_aktivitas_provinsi, dan npsn_ganda_detail
    let totalDihapus = 0;
    if (isFinished && body.namaProvinsi && body.namaProvinsi !== 'SEMUA') {
      try {
        const activeList = customParams.activeNpsnList || body.activeNpsnList;
        const isClean = customParams.isCleanScan || body.isCleanScan;

        // Pembersihan otomatis sekolah non-aktif (yang dihapus dari Belajar.id)
        if (isClean && Array.isArray(activeList) && activeList.length > 0) {
          try {
            // 1. Coba jalankan via PostgreSQL stored procedure (RPC) jika tersedia di Supabase
            const { data: rpcDeleted, error: rpcErr } = await supabase.rpc('fn_clean_inactive_sekolah', {
              p_nama_provinsi: body.namaProvinsi,
              p_active_npsns: activeList,
            });

            if (!rpcErr && typeof rpcDeleted === 'number') {
              totalDihapus = rpcDeleted;
              console.log(`[CLEANUP] Berhasil menghapus ${totalDihapus} sekolah non-aktif via RPC untuk ${body.namaProvinsi}`);
            } else {
              // 2. Fallback JavaScript: Ambil seluruh NPSN yang ada di DB untuk provinsi ini dan hapus selisihnya
              let from = 0;
              const dbNpsns = [];
              const provKey = body.namaProvinsi.startsWith('PROV.') ? body.namaProvinsi : `PROV. ${body.namaProvinsi}`;

              while (true) {
                const { data, error: fetchErr } = await supabase
                  .from('sekolah')
                  .select('npsn')
                  .or(`nama_provinsi.eq."${provKey}",nama_provinsi.eq."${body.namaProvinsi}"`)
                  .order('npsn')
                  .range(from, from + 999);

                if (fetchErr || !data || data.length === 0) break;
                dbNpsns.push(...data.map((d) => String(d.npsn)));
                if (data.length < 1000) break;
                from += 1000;
              }

              if (dbNpsns.length > 0) {
                const activeSet = new Set(activeList.map((n) => String(n)));
                const staleNpsns = dbNpsns.filter((n) => n && !activeSet.has(n));

                if (staleNpsns.length > 0) {
                  console.log(`[CLEANUP] Ditemukan ${staleNpsns.length} sekolah tidak aktif di ${body.namaProvinsi}. Menghapus dari Supabase...`);
                  for (let i = 0; i < staleNpsns.length; i += 200) {
                    const chunk = staleNpsns.slice(i, i + 200);
                    await supabase.from('sekolah').delete().in('npsn', chunk);
                  }
                  totalDihapus = staleNpsns.length;
                }
              }
            }
          } catch (errClean) {
            console.warn('Gagal membersihkan sekolah non-aktif:', errClean.message);
          }
        }

        // Ambil hitungan riil dari DB untuk provinsi ini setelah pembersihan sekolah non-aktif
        let currentDbCount = 0;
        try {
          const { count } = await supabase
            .from('sekolah')
            .select('*', { count: 'exact', head: true })
            .ilike('nama_provinsi', `%${body.namaProvinsi}%`);
          currentDbCount = count || 0;
        } catch (e) {}

        // Update total_sekolah aktual dan akumulasi total_dihapus pada status_sinkronisasi
        try {
          const { count: grandCount } = await supabase.from('sekolah').select('*', { count: 'exact', head: true });
          const statUpdate = { updated_at: new Date().toISOString() };
          if (grandCount && grandCount > 0) statUpdate.total_sekolah = grandCount;
          if (totalDihapus > 0) statUpdate.total_dihapus = (currentStatus?.total_dihapus || 0) + totalDihapus;
          await supabase.from('status_sinkronisasi').update(statUpdate).in('id', [1, 2]);
        } catch (eStat) {}

        const provStatusData = {
          nama_provinsi: body.namaProvinsi,
          terakhir_sukses: new Date().toISOString(),
          api_duplicates: customParams.duplicates?.length || 0,
          api_empty_npsn: totalTanpaNpsn,
          api_unrecognized_shapes: customParams.unrecognized_shapes || 0,
        };
        if (currentDbCount > 0) {
          provStatusData.total_db = currentDbCount;
        }
        await supabase.from('provinsi_sync_status').upsert(provStatusData);

        const finalBaru = customParams.provStats?.baru ?? (totalBaru > 0 ? totalBaru : (currentStatus?.total_baru || 0));
        const finalDiperbarui = customParams.provStats?.diperbarui ?? (totalDiperbarui > 0 ? totalDiperbarui : (currentStatus?.total_diperbarui || 0));
        const finalTidakBerubah = customParams.provStats?.tidakBerubah ?? (totalTidakBerubah > 0 ? totalTidakBerubah : (currentStatus?.total_tidak_berubah || 0));

        await supabase.from('log_aktivitas_provinsi').insert({
          nama_provinsi: body.namaProvinsi,
          total_baru: finalBaru,
          total_diperbarui: finalDiperbarui,
          total_dihapus: totalDihapus,
          total_tidak_berubah: finalTidakBerubah,
          waktu_selesai: new Date().toISOString(),
        });

        // Bersihkan otomatis dari database: pertahankan hanya maksimal 10 log terbaru
        try {
          const { data: excessLogs } = await supabase
            .from('log_aktivitas_provinsi')
            .select('id')
            .order('waktu_selesai', { ascending: false })
            .range(10, 100);

          if (excessLogs && excessLogs.length > 0) {
            const deleteIds = excessLogs.map((x) => x.id);
            await supabase.from('log_aktivitas_provinsi').delete().in('id', deleteIds);
          }
        } catch (eCleanLog) {
          console.warn('Gagal membersihkan log lama di sync-batch:', eCleanLog.message);
        }

        // Simpan rincian duplikat ke npsn_ganda_detail jika ada
        if (customParams.duplicates && Array.isArray(customParams.duplicates) && customParams.duplicates.length > 0) {
          const dupRecords = customParams.duplicates.map((d) => ({
            npsn: String(d.npsn),
            nama_provinsi: body.namaProvinsi,
            sekolah_detail: typeof d.sekolahList === 'string' ? d.sekolahList : JSON.stringify(d.sekolahList || []),
          }));
          await supabase.from('npsn_ganda_detail').upsert(dupRecords, { onConflict: 'npsn,nama_provinsi' });
        }

        // Update cache_data 'perbandingan' seketika agar perbandingan data langsung sinkron tanpa jeda
        try {
          const { data: cacheRow } = await supabase
            .from('cache_data')
            .select('value')
            .eq('key', 'perbandingan')
            .single();

          if (cacheRow?.value) {
            const list = JSON.parse(cacheRow.value);
            const cleanP = cleanName(body.namaProvinsi);
            const item = list.find((x) => cleanName(x.nama) === cleanP);
            if (item) {
              item.total_db = currentDbCount > 0 ? currentDbCount : (item.total_db || 0);
              item.terakhir_sukses = new Date().toISOString();
              item.api_duplicates = customParams.duplicates?.length || 0;
              item.api_empty_npsn = totalTanpaNpsn || 0;
              item.api_unrecognized_shapes = customParams.unrecognized_shapes || 0;
              item.raw_selisih = (item.total_api || 0) - (item.total_db || 0);
              item.selisih = item.raw_selisih - (item.api_duplicates || 0);
              if (item.selisih <= 0) {
                item.selisih = 0;
                item.is_sinkron_walau_selisih = true;
              }
              await supabase.from('cache_data').upsert({
                key: 'perbandingan',
                value: JSON.stringify(list),
                updated_at: new Date().toISOString(),
              });
            }
          }
        } catch (errCache) {
          console.warn('Gagal update cache perbandingan di sync-batch:', errCache.message);
        }
      } catch (e) {
        console.warn('Gagal simpan log provinsi / detail duplikat:', e.message);
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        stats: {
          ...stats,
          dihapus: totalDihapus,
        },
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
