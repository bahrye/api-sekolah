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
      const lastUpdated = new Date(activeRow.updated_at);
      if (Date.now() - lastUpdated.getTime() < 90 * 1000) {
        isRunning = true;
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        isCustom,
        isRunning,
        selesai,
        activeProvince,
        bentukBerikutnya,
        offsetBerikutnya,
        totalSynced,
        totalEstimasi,
        progressPercent,
        activeRow,
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
