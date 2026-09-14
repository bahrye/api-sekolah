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

    // Jika proses telah dibatalkan oleh admin (bentuk_aktif === 'Selesai') dan bukan awal baru, tolak batch agar runner berhenti
    if (!body.isStart && currentStatus && currentStatus.bentuk_aktif === 'Selesai') {
      return new Response(
        JSON.stringify({ ok: false, cancelled: true, message: 'Sinkronisasi telah dibatalkan dari panel kontrol.' }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

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

    const isJobFinished = (isFinished && isCustom && bentukAktif === 'Selesai') || (!isCustom && isFinished);

    // Update status di Supabase
    await supabase.from('status_sinkronisasi').upsert({
      id: targetId,
      bentuk_aktif: isJobFinished ? 'Selesai' : displayBentuk,
      offset_terakhir: isFinished ? 0 : (offset || 0),
      total_baru: isJobFinished ? 0 : totalBaru,
      total_diperbarui: isJobFinished ? 0 : totalDiperbarui,
      total_tidak_berubah: isJobFinished ? 0 : totalTidakBerubah,
      total_tanpa_npsn: isJobFinished ? 0 : totalTanpaNpsn,
      total_dihapus: isJobFinished ? 0 : (currentStatus?.total_dihapus || 0),
      total_estimasi: totalEstimasi,
      updated_at: new Date().toISOString(),
      waktu_selesai_terakhir: isFinished ? new Date().toISOString() : (currentStatus?.waktu_selesai_terakhir || null),
    });

    if (isJobFinished) {
      // Pastikan kedua record (id 1 dan 2) kartu counter-nya di-reset bersih / 0 karena log tersimpan di riwayat
      try {
        await supabase.from('status_sinkronisasi').update({
          total_baru: 0,
          total_diperbarui: 0,
          total_tidak_berubah: 0,
          total_dihapus: 0,
          total_tanpa_npsn: 0,
        }).in('id', [1, 2]);
      } catch (eReset) {}

      // AUTO-CHAINING ANTREAN: Cek apakah ada antrean di cache_data sync_queue
      try {
        const { data: qRow } = await supabase
          .from('cache_data')
          .select('value')
          .eq('key', 'sync_queue')
          .maybeSingle();

        if (qRow && qRow.value) {
          const queue = JSON.parse(qRow.value);
          if (Array.isArray(queue) && queue.length > 0) {
            const nextItem = queue.shift();
            await supabase.from('cache_data').upsert({
              key: 'sync_queue',
              value: JSON.stringify(queue),
              updated_at: new Date().toISOString(),
            });

            let githubToken = env.GITHUB_TOKEN || env.GH_TOKEN;
            if (!githubToken) {
              const { data: tokRow } = await supabase
                .from('cache_data')
                .select('value')
                .eq('key', 'github_token')
                .maybeSingle();
              if (tokRow?.value) githubToken = tokRow.value.trim();
            }

            if (githubToken && nextItem?.provinsi) {
              console.log(`[QUEUE] Memulai otomatis antrean berikutnya: ${nextItem.provinsi}`);
              const repo = 'bahrye/api-sekolah';
              const wfUrl = `https://api.github.com/repos/${repo}/actions/workflows/sync-sekolah-15m.yml/dispatches`;
              await fetch(wfUrl, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${githubToken}`,
                  'Accept': 'application/vnd.github+json',
                  'User-Agent': 'api-sekolah-queue-dispatcher',
                },
                body: JSON.stringify({
                  ref: 'main',
                  inputs: {
                    pilihan_provinsi: nextItem.provinsi,
                    mulai_dari_awal: Boolean(nextItem.mulai_dari_awal) ? 'true' : 'false',
                  }
                }),
              });
            }
          }
        }
      } catch (eQueue) {
        console.warn('[QUEUE] Gagal memproses antrean berikutnya:', eQueue.message);
      }
    }

    // Jika provinsi selesai, jalankan pembersihan data nonaktif, catat ke provinsi_sync_status, log_aktivitas_provinsi, dan npsn_ganda_detail
    let totalDihapus = 0;
    if (isFinished && body.namaProvinsi && body.namaProvinsi !== 'SEMUA') {
      try {
        const activeList = customParams.activeNpsnList || body.activeNpsnList;
        const isClean = customParams.isCleanScan || body.isCleanScan;

        // Pembersihan otomatis sekolah non-aktif (yang dihapus dari data pusat)
        if (isClean && Array.isArray(activeList) && activeList.length > 0) {
          try {
            let from = 0;
            const dbNpsns = [];
            let provQuery = (body.namaProvinsi || '').replace(/^PROVINSI|^PROV\.?\s*/i, '').trim();
            if (provQuery.includes('JAKARTA')) provQuery = 'JAKARTA';
            if (provQuery.includes('YOGYAKARTA')) provQuery = 'YOGYAKARTA';

            while (true) {
              const { data, error: fetchErr } = await supabase
                .from('sekolah')
                .select('npsn')
                .ilike('nama_provinsi', `%${provQuery}%`)
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
                for (let i = 0; i < staleNpsns.length; i += 100) {
                  const chunk = staleNpsns.slice(i, i + 100);
                  await supabase.from('sekolah').delete().in('npsn', chunk);
                }
                totalDihapus = staleNpsns.length;
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

        const remainingUnrecognized = Math.max(0, (customParams.totalEstimasi || 0) - currentDbCount);
        const resolvedUnrecognized = Math.min(customParams.unrecognized_shapes ?? remainingUnrecognized, remainingUnrecognized);

        const provStatusData = {
          nama_provinsi: body.namaProvinsi,
          terakhir_sukses: new Date().toISOString(),
          api_duplicates: customParams.duplicates?.length || 0,
          api_empty_npsn: totalTanpaNpsn,
          api_unrecognized_shapes: resolvedUnrecognized,
        };
        if (currentDbCount > 0) {
          provStatusData.total_db = currentDbCount;
        }
        await supabase.from('provinsi_sync_status').upsert(provStatusData);

        const finalBaru = customParams.provStats?.baru ?? (totalBaru > 0 ? totalBaru : (currentStatus?.total_baru || 0));
        const finalDiperbarui = customParams.provStats?.diperbarui ?? (totalDiperbarui > 0 ? totalDiperbarui : (currentStatus?.total_diperbarui || 0));
        const finalTidakBerubah = customParams.provStats?.tidakBerubah ?? (totalTidakBerubah > 0 ? totalTidakBerubah : (currentStatus?.total_tidak_berubah || 0));

        const { error: logErr } = await supabase.from('log_aktivitas_provinsi').insert({
          nama_provinsi: body.namaProvinsi,
          total_baru: finalBaru,
          total_diperbarui: finalDiperbarui,
          total_dihapus: totalDihapus,
          total_tidak_berubah: finalTidakBerubah,
          total_non_queryable: customParams.nonQueryableCount || resolvedUnrecognized || 0,
          waktu_selesai: new Date().toISOString(),
        });
        if (logErr) {
          console.error(`[SYNC-BATCH] Gagal mencatat log_aktivitas_provinsi untuk ${body.namaProvinsi}:`, logErr.message);
        }

        // Bersihkan otomatis dari database: hapus log yang lebih lama dari 3 hari agar riwayat kuota harian tidak hilang
        try {
          const threeDaysAgoUtc = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
          await supabase
            .from('log_aktivitas_provinsi')
            .delete()
            .lt('waktu_selesai', threeDaysAgoUtc);
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
              item.api_unrecognized_shapes = resolvedUnrecognized;
              item.raw_selisih = (item.total_api || 0) - (item.total_db || 0);
              let selisihVal = item.raw_selisih;
              if (item.raw_selisih > 0) {
                const effDup = (item.api_duplicates || 0);
                const effUnrec = (item.api_unrecognized_shapes || 0);
                selisihVal = Math.max(0, item.raw_selisih - effDup - effUnrec);
              }
              item.selisih = selisihVal;
              item.extra_in_db = Math.max(0, (item.total_db || 0) - (item.total_api || 0));
              item.is_sinkron_walau_selisih = (item.selisih === 0);
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
