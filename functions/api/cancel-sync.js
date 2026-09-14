import { getSupabase } from '../lib/db.js';
import { getSessionFromRequest } from '../lib/auth.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  // 1. Verifikasi Autentikasi Admin
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ ok: false, error: 'Sesi Anda telah berakhir. Silakan login kembali.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabase = getSupabase(env);

    // 2. Ambil token GitHub untuk cancel workflow run yang aktif di GitHub Actions
    let githubToken = env.GITHUB_TOKEN || env.GH_TOKEN;
    if (!githubToken) {
      const { data: tokRow } = await supabase
        .from('cache_data')
        .select('value')
        .eq('key', 'github_token')
        .maybeSingle();
      if (tokRow && tokRow.value) {
        githubToken = tokRow.value.trim();
      }
    }

    let cancelledRunsCount = 0;
    if (githubToken) {
      const repo = 'bahrye/api-sekolah';
      const runsUrl = `https://api.github.com/repos/${repo}/actions/runs?status=in_progress`;
      const queuedUrl = `https://api.github.com/repos/${repo}/actions/runs?status=queued`;

      try {
        const [resInProg, resQueued] = await Promise.all([
          fetch(runsUrl, {
            headers: {
              'Authorization': `Bearer ${githubToken}`,
              'Accept': 'application/vnd.github+json',
              'User-Agent': 'api-sekolah-cancel',
            },
          }),
          fetch(queuedUrl, {
            headers: {
              'Authorization': `Bearer ${githubToken}`,
              'Accept': 'application/vnd.github+json',
              'User-Agent': 'api-sekolah-cancel',
            },
          }),
        ]);

        const inProgData = resInProg.ok ? await resInProg.json() : {};
        const queuedData = resQueued.ok ? await resQueued.json() : {};
        const activeRuns = [...(inProgData.workflow_runs || []), ...(queuedData.workflow_runs || [])];

        for (const run of activeRuns) {
          try {
            const cancelRes = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/cancel`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${githubToken}`,
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'api-sekolah-cancel',
              },
            });
            if (cancelRes.ok || cancelRes.status === 202) {
              cancelledRunsCount++;
              console.log(`[CANCEL] Berhasil membatalkan workflow run #${run.id} (${run.name})`);
            }
          } catch (eCancel) {
            console.warn(`[CANCEL] Gagal membatalkan run #${run.id}:`, eCancel.message);
          }
        }
      } catch (errGh) {
        console.warn('[CANCEL] Gagal memeriksa workflow run di GitHub:', errGh.message);
      }
    }

    // 3. Reset status_sinkronisasi di Supabase agar status langsung menjadi Selesai (Idle)
    const nowIso = new Date().toISOString();
    const fiveMinsAgo = new Date(Date.now() - 300 * 1000).toISOString();
    await supabase
      .from('status_sinkronisasi')
      .update({
        bentuk_aktif: 'Selesai',
        offset_terakhir: 0,
        total_baru: 0,
        total_diperbarui: 0,
        total_tidak_berubah: 0,
        total_dihapus: 0,
        total_tanpa_npsn: 0,
        updated_at: fiveMinsAgo,
        waktu_selesai_terakhir: nowIso,
      })
      .in('id', [1, 2]);

    return new Response(
      JSON.stringify({
        ok: true,
        message: cancelledRunsCount > 0
          ? `Sinkronisasi berhasil dibatalkan (${cancelledRunsCount} workflow dihentikan).`
          : 'Sinkronisasi berhasil dibatalkan dan status sistem telah direset ke Siap.',
        cancelled_runs: cancelledRunsCount,
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  } catch (err) {
    console.error('Error in cancel-sync:', err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
