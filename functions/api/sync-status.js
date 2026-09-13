import { getSupabase } from '../lib/db.js';
import { VALID_BENTUK } from '../lib/sync-supabase-core.js';

export async function onRequestGet(context) {
  try {
    const supabase = getSupabase(context.env);

    const { data: results, error } = await supabase
      .from('status_sinkronisasi')
      .select('*')
      .in('id', [1, 2]);

    if (error) throw error;

    let row1 = results?.find((r) => r.id === 1) || { bentuk_aktif: 'tk', offset_terakhir: 0 };
    let row2 = results?.find((r) => r.id === 2);

    let activeRow = row1;
    let isCustom = false;

    if (row2 && row2.updated_at && row1.updated_at) {
      const t1 = new Date(row1.updated_at).getTime();
      const t2 = new Date(row2.updated_at).getTime();
      if (t2 > t1) {
        activeRow = row2;
        isCustom = true;
      }
    } else if (row2 && !row1.updated_at) {
      activeRow = row2;
      isCustom = true;
    }

    const bentukBerikutnya = activeRow.bentuk_aktif || 'tk';
    const offsetBerikutnya = activeRow.offset_terakhir || 0;
    const totalSynced =
      (activeRow.total_baru || 0) +
      (activeRow.total_diperbarui || 0) +
      (activeRow.total_tidak_berubah || 0);
    const totalEstimasi = activeRow.total_estimasi || 553831;

    const currentIndex = VALID_BENTUK.indexOf(bentukBerikutnya);
    let progressPercent = 0;
    if (isCustom) {
      progressPercent = totalEstimasi > 0 ? Math.min(100, Math.round((totalSynced / totalEstimasi) * 100)) : 0;
    } else {
      progressPercent = Math.max(0, Math.round((currentIndex / VALID_BENTUK.length) * 100));
    }

    const selesai = isCustom
      ? bentukBerikutnya === 'Selesai'
      : bentukBerikutnya === 'tk' && offsetBerikutnya === 0 && activeRow.waktu_selesai_terakhir !== null && progressPercent === 0;

    if (selesai) progressPercent = 100;

    let activeProvince = null;
    if (activeRow.bentuk_aktif) {
      const match = activeRow.bentuk_aktif.match(/\((.*?)\)/);
      if (match) activeProvince = match[1];
    }

    let isRunning = false;
    if (activeRow.updated_at && !selesai) {
      let t = new Date(activeRow.updated_at).getTime();
      if (isNaN(t)) {
        t = new Date(activeRow.updated_at.replace(' ', 'T')).getTime();
      }
      if (!isNaN(t) && (Date.now() - t < 120 * 1000)) {
        isRunning = true;
      }
    }

    // Hitung kuota harian riil
    const currentDayOfWeek = new Date(Date.now() + 7 * 60 * 60 * 1000).getUTCDay() || 7;
    const isMandatoryUpdateDay = (currentDayOfWeek === 3 || currentDayOfWeek === 4);
    const batasAman = isMandatoryUpdateDay ? 350000 : 150000;

    let syncedToday = 0;
    try {
      const nowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
      const wibDateStr = nowWib.toISOString().split('T')[0];
      const startOfWibDayUtc = new Date(`${wibDateStr}T00:00:00+07:00`).toISOString();

      const { data: logs } = await supabase
        .from('log_aktivitas_provinsi')
        .select('total_baru, total_diperbarui, total_tidak_berubah')
        .gte('waktu_selesai', startOfWibDayUtc);

      syncedToday = (logs || []).reduce(
        (acc, l) => acc + (l.total_baru || 0) + (l.total_diperbarui || 0) + (l.total_tidak_berubah || 0),
        0
      );
    } catch (e) {}

    if (isCustom && activeRow.updated_at) {
      let t = new Date(activeRow.updated_at).getTime();
      if (isNaN(t)) t = new Date(activeRow.updated_at.replace(' ', 'T')).getTime();
      if (!isNaN(t) && (Date.now() - t < 5 * 60000)) {
        const currentRunning = (activeRow.total_baru || 0) + (activeRow.total_diperbarui || 0) + (activeRow.total_tidak_berubah || 0);
        syncedToday += currentRunning;
      }
    }

    let totalNonQueryable = 0;
    try {
      let targetProvince = activeProvince;
      if (!targetProvince) {
        const { data: lastLog } = await supabase
          .from('log_aktivitas_provinsi')
          .select('total_non_queryable, nama_provinsi')
          .order('waktu_selesai', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (lastLog) {
          if (typeof lastLog.total_non_queryable === 'number' && lastLog.total_non_queryable > 0) {
            totalNonQueryable = lastLog.total_non_queryable;
          } else {
            targetProvince = lastLog.nama_provinsi;
          }
        }
      }

      if (!totalNonQueryable && targetProvince) {
        const cleanP = targetProvince.replace(/[^A-Z0-9]/gi, '').toUpperCase().replace(/^PROVINSI|^PROV/, '');
        const { data: pss } = await supabase
          .from('provinsi_sync_status')
          .select('api_unrecognized_shapes')
          .ilike('nama_provinsi', `%${cleanP}%`)
          .maybeSingle();
        if (pss?.api_unrecognized_shapes) {
          totalNonQueryable = pss.api_unrecognized_shapes;
        } else {
          const { data: cRow } = await supabase
            .from('cache_data')
            .select('value')
            .eq('key', 'perbandingan')
            .single();
          if (cRow && cRow.value) {
            const list = JSON.parse(cRow.value);
            const found = list.find(item => item.nama && item.nama.replace(/[^A-Z0-9]/gi, '').toUpperCase().includes(cleanP));
            if (found && typeof found.api_unrecognized_shapes === 'number') {
              totalNonQueryable = found.api_unrecognized_shapes;
            }
          }
        }
      }
    } catch (e) {}

    const isStatReset = Boolean(selesai || bentukBerikutnya === 'Selesai' || (!isRunning && offsetBerikutnya === 0));
    if (isStatReset) {
      totalNonQueryable = 0;
      activeRow = {
        ...activeRow,
        total_baru: 0,
        total_diperbarui: 0,
        total_dihapus: 0,
        total_tidak_berubah: 0,
        total_tanpa_npsn: 0,
      };
    }

    return new Response(
      JSON.stringify({
        ok: true,
        isCustom,
        isRunning,
        selesai,
        activeProvince,
        total_non_queryable: totalNonQueryable,
        bentukBerikutnya,
        offsetBerikutnya,
        totalSynced,
        totalEstimasi,
        progressPercent,
        activeRow,
        syncedToday,
        batasAman,
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
