import { getSupabase } from '../lib/db.js';
import { getSessionFromRequest } from '../lib/auth.js';

const parseDateMs = (dStr) => {
  if (!dStr) return 0;
  if (typeof dStr === 'number') return dStr;
  const s = String(dStr).trim();
  if (s.includes('Z') || s.includes('+') || /T.*[+-]\d{2}/.test(s)) {
    const t = new Date(s).getTime();
    if (!isNaN(t)) return t;
  }
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) {
    const iso = s.replace(' ', 'T') + 'Z';
    const t = new Date(iso).getTime();
    if (!isNaN(t)) return t;
  }
  const t = new Date(s).getTime();
  return isNaN(t) ? 0 : t;
};

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
    const body = await request.json().catch(() => ({}));
    const rawProvinsi = (body.provinsi || '').trim();
    const isMulaiAwal = body.mulai_dari_awal === true || body.mulai_dari_awal === 'true';

    if (!rawProvinsi) {
      return new Response(JSON.stringify({ ok: false, error: 'Nama provinsi wajib dipilih.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const supabase = getSupabase(env);

    // 2. Periksa apakah sinkronisasi sedang berjalan (hanya 1 sinkronisasi aktif diperbolehkan)
    const { data: statusRows } = await supabase
      .from('status_sinkronisasi')
      .select('*')
      .order('id', { ascending: true });

    const row1 = statusRows?.find(r => r.id === 1) || { bentuk_aktif: 'tk', offset_terakhir: 0 };
    const row2 = statusRows?.find(r => r.id === 2);
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

    const bentukBerikutnya = activeRow.bentuk_aktif || '';
    const offsetBerikutnya = activeRow.offset_terakhir || 0;
    const isExplicitlyFinished = Boolean(
      bentukBerikutnya && (bentukBerikutnya === 'Selesai' || bentukBerikutnya.toLowerCase() === 'selesai')
    );
    const selesai = isExplicitlyFinished || (
      isCustom
        ? false
        : (bentukBerikutnya === 'tk' && offsetBerikutnya === 0 && activeRow.waktu_selesai_terakhir !== null)
    );

    let isRunning = false;
    let activeProvince = null;
    if (bentukBerikutnya && !isExplicitlyFinished) {
      const match = bentukBerikutnya.match(/\((.*?)\)/);
      if (match) activeProvince = match[1];
    }

    if (!isExplicitlyFinished && activeRow.updated_at && !selesai) {
      const lastUpdatedMs = parseDateMs(activeRow.updated_at);
      if (lastUpdatedMs > 0 && (Date.now() - lastUpdatedMs < 120 * 1000)) {
        isRunning = true;
      }
    }

    if (isRunning) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: `Sinkronisasi sedang berlangsung untuk wilayah ${activeProvince ? `(${activeProvince})` : ''}. Hanya 1 proses sinkronisasi yang dapat berjalan dalam satu waktu.`,
        }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // 3. Ambil GitHub Personal Access Token (dari env atau database cache_data)
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

    if (!githubToken) {
      return new Response(
        JSON.stringify({
          ok: false,
          need_token: true,
          error: 'GitHub Token belum dikonfigurasi. Silakan masukkan Personal Access Token (PAT) GitHub melalui menu Pengaturan Token di dashboard ini.',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // 4. Panggil GitHub Actions REST API (workflow dispatch)
    const repo = 'bahrye/api-sekolah';
    const workflowFile = 'sync-sekolah-15m.yml';
    const dispatchUrl = `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/dispatches`;

    const ghRes = await fetch(dispatchUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'api-sekolah-sync-manual',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          pilihan_provinsi: rawProvinsi,
          mulai_dari_awal: isMulaiAwal ? 'true' : 'false',
        },
      }),
    });

    if (!ghRes.ok && ghRes.status !== 204) {
      const errText = await ghRes.text();
      let errMsg = 'Gagal memicu GitHub Action';
      try {
        const errJson = JSON.parse(errText);
        errMsg = errJson.message || errMsg;
      } catch {
        errMsg = errText || errMsg;
      }

      console.error('GitHub dispatch failed:', ghRes.status, errText);
      return new Response(
        JSON.stringify({
          ok: false,
          error: `Gagal memicu workflow di GitHub Actions (${ghRes.status}): ${errMsg}. Pastikan token memiliki hak akses 'actions:write'.`,
        }),
        {
          status: ghRes.status === 401 ? 400 : 502,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // 5. Update status_sinkronisasi segera agar dashboard real-time langsung bereaksi
    try {
      const nowIso = new Date().toISOString();
      if (isMulaiAwal) {
        await supabase.from('status_sinkronisasi').upsert({
          id: 1,
          bentuk_aktif: `tk (${rawProvinsi})`,
          offset_terakhir: 0,
          total_sukses: 0,
          total_gagal: 0,
          updated_at: nowIso,
        });
      } else {
        await supabase.from('status_sinkronisasi').upsert({
          id: 1,
          bentuk_aktif: `tk (${rawProvinsi})`,
          updated_at: nowIso,
        });
      }
    } catch (dbErr) {
      console.warn('Gagal pre-set status_sinkronisasi:', dbErr.message);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        provinsi: rawProvinsi,
        message: `Sinkronisasi untuk provinsi ${rawProvinsi} berhasil dipicu di GitHub Actions!`,
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err) {
    console.error('Error trigger sync:', err);
    return new Response(
      JSON.stringify({ ok: false, error: 'Terjadi kesalahan sistem: ' + err.message }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
