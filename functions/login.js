import { getSupabase } from './lib/db.js';
import { getSessionFromRequest } from './lib/auth.js';

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

const formatWIB = (dStr) => {
  if (!dStr) return '-';
  if (typeof dStr === 'string' && dStr.includes('WIB')) return dStr;
  const ms = parseDateMs(dStr);
  if (!ms) return dStr;
  const d = new Date(ms + 7 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const Y = d.getUTCFullYear();
  const M = pad(d.getUTCMonth() + 1);
  const D = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const m = pad(d.getUTCMinutes());
  return `${D}-${M}-${Y} ${h}:${m} WIB`;
};

const cleanName = (name) => {
  if (!name) return '';
  return name.replace(/[^A-Z0-9]/gi, '').toUpperCase().replace(/^PROVINSI|^PROV/, '');
};

const getWibDate = (d = new Date()) => {
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? '' : new Date(dt.getTime() + 7 * 3600 * 1000).toISOString().split('T')[0];
};

const maskEmail = (email) => {
  if (!email || typeof email !== 'string') return 'Administrator';
  const parts = email.split('@');
  if (parts.length !== 2) return 'Administrator';
  const user = parts[0];
  const domain = parts[1];
  const maskedUser = user.length > 2 ? user.slice(0, 2) + '***' : user[0] + '***';
  return `${maskedUser}@${domain}`;
};

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // Periksa sesi login
  const session = await getSessionFromRequest(request, env);

  // 1. JIKA BELUM LOGIN: Render Halaman Form Login
  if (!session) {
    return new Response(renderLoginForm(), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  }

  // 2. JIKA SUDAH LOGIN: Render Dashboard Admin Manual Trigger
  const supabase = getSupabase(env);
  const clientSupabaseUrl = env?.SUPABASE_URL || '';
  const clientSupabaseAnonKey = env?.SUPABASE_ANON_KEY || '';

  try {
    let compareList = [];
    let lastChecked = 'Belum ada data';

    // Optimasi performa: Jalankan query paralel dan hindari query view agregat berat v_rekap_provinsi
    const [
      { data: results },
      { data: provRes },
      { data: cacheRow },
      { data: qRowRes }
    ] = await Promise.all([
      supabase.from('status_sinkronisasi').select('*').in('id', [1, 2]),
      supabase.from('provinsi_sync_status').select('nama_provinsi, total_db, terakhir_sukses, api_duplicates, api_empty_npsn, api_unrecognized_shapes'),
      supabase.from('cache_data').select('value, updated_at').eq('key', 'perbandingan').maybeSingle(),
      supabase.from('cache_data').select('value').eq('key', 'sync_queue').maybeSingle()
    ]);

    const provStatusList = provRes || [];
    let initialQueue = [];
    if (qRowRes?.value) {
      try { initialQueue = JSON.parse(qRowRes.value); } catch (e) {}
    }

    if (cacheRow && cacheRow.value) {
      lastChecked = formatWIB(cacheRow.updated_at);
      const rawCompare = JSON.parse(cacheRow.value);
      const pMap = new Map();
      provStatusList.forEach(r => {
        const k = cleanName(r.nama_provinsi);
        if (!pMap.has(k) || ((r.total_db || 0) > (pMap.get(k).total_db || 0))) {
          pMap.set(k, r);
        }
      });

      rawCompare.forEach(item => {
        const cName = cleanName(item.nama);
        if ((!item.total_db || item.total_db <= 0) && pMap.has(cName) && pMap.get(cName).total_db > 0) {
          item.total_db = pMap.get(cName).total_db;
        }

        if (pMap.has(cName)) {
          const p = pMap.get(cName);
          if (p.terakhir_sukses) item.terakhir_sukses = p.terakhir_sukses;
          item.api_duplicates = p.api_duplicates || 0;
          item.api_empty_npsn = p.api_empty_npsn || 0;
          item.api_unrecognized_shapes = p.api_unrecognized_shapes || 0;
        }

        item.raw_selisih = (item.total_api || 0) - (item.total_db || 0);
        let selisihVal = item.raw_selisih;
        if (item.raw_selisih > 0) {
          const effDuplicates = (item.api_duplicates || 0);
          const effUnrecognized = Math.min(item.raw_selisih, item.api_unrecognized_shapes || 0);
          selisihVal = Math.max(0, item.raw_selisih - effDuplicates - effUnrecognized);
        }
        item.selisih = selisihVal;
        item.extra_in_db = Math.max(0, (item.total_db || 0) - (item.total_api || 0));
        item.is_sinkron_walau_selisih = (item.selisih === 0);
      });

      compareList = rawCompare;
    }

    const row1 = results?.find(r => r.id === 1) || { bentuk_aktif: 'tk', offset_terakhir: 0 };
    const row2 = results?.find(r => r.id === 2);
    let activeRow = row1;
    let isCustom = false;

    if (row2 && row2.updated_at && row1.updated_at) {
      const t1 = parseDateMs(row1.updated_at);
      const t2 = parseDateMs(row2.updated_at);
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

    let activeProvince = null;
    if (activeRow.bentuk_aktif && !isExplicitlyFinished) {
      const match = activeRow.bentuk_aktif.match(/\((.*?)\)/);
      if (match) activeProvince = match[1];
    }

    let isRunning = false;
    if (!isExplicitlyFinished && activeRow.updated_at && !selesai) {
      const lastUpdatedMs = parseDateMs(activeRow.updated_at);
      if (lastUpdatedMs > 0 && (Date.now() - lastUpdatedMs < 120 * 1000)) {
        isRunning = true;
      }
    }

    // Urutkan provinsi: jika ada yang sedang aktif disinkronkan, letakkan di urutan teratas
    if (isRunning && activeProvince) {
      const cleanActive = cleanName(activeProvince);
      compareList.sort((a, b) => {
        const aActive = cleanName(a.nama) === cleanActive ? 1 : 0;
        const bActive = cleanName(b.nama) === cleanActive ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        const aDiff = (!a.is_sinkron_walau_selisih && (a.selisih !== 0 || a.raw_selisih !== 0)) ? 1 : 0;
        const bDiff = (!b.is_sinkron_walau_selisih && (b.selisih !== 0 || b.raw_selisih !== 0)) ? 1 : 0;
        if (aDiff !== bDiff) return bDiff - aDiff;
        return a.nama.localeCompare(b.nama);
      });
    } else {
      compareList.sort((a, b) => {
        const aDiff = (!a.is_sinkron_walau_selisih && (a.selisih !== 0 || a.raw_selisih !== 0)) ? 1 : 0;
        const bDiff = (!b.is_sinkron_walau_selisih && (b.selisih !== 0 || b.raw_selisih !== 0)) ? 1 : 0;
        if (aDiff !== bDiff) return bDiff - aDiff;
        return a.nama.localeCompare(b.nama);
      });
    }

    return new Response(
      renderDashboard({
        session,
        compareList,
        activeRow,
        activeProvince,
        isRunning,
        selesai,
        lastChecked,
        clientSupabaseUrl,
        clientSupabaseAnonKey,
        initialQueue,
      }),
      {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, max-age=0',
        },
      }
    );
  } catch (err) {
    return new Response('Terjadi kesalahan memuat dashboard: ' + err.message, { status: 500 });
  }
}

// -------------------------------------------------------------------------------------------------
// 1. TAMPILAN FORM LOGIN (GUEST MODE)
// -------------------------------------------------------------------------------------------------
function renderLoginForm() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login Panel Sinkronisasi — EduAPI Indonesia</title>
  <link rel="icon" href="/favicon-sync.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #07090e;
      --card-bg: rgba(17, 24, 39, 0.7);
      --card-border: rgba(255, 255, 255, 0.08);
      --primary: #6366f1;
      --primary-light: #818cf8;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --danger: #fb7185;
      --success: #34d399;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      background: radial-gradient(circle at 50% 0%, #1e1b4b 0%, #0b0f19 50%, #05070c 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      color: var(--text-main);
      overflow-x: hidden;
      position: relative;
    }
    .orb {
      position: absolute;
      border-radius: 50%;
      filter: blur(100px);
      z-index: 0;
      pointer-events: none;
    }
    .orb-1 {
      width: 450px;
      height: 450px;
      background: rgba(99, 102, 241, 0.2);
      top: -100px;
      left: 50%;
      transform: translateX(-50%);
    }
    .orb-2 {
      width: 350px;
      height: 350px;
      background: rgba(236, 72, 153, 0.12);
      bottom: -50px;
      right: 15%;
    }
    .login-card {
      position: relative;
      z-index: 1;
      width: 100%;
      max-width: 440px;
      background: var(--card-bg);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border: 1px solid var(--card-border);
      border-radius: 28px;
      padding: 40px 32px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 40px rgba(99, 102, 241, 0.1);
      animation: fadeIn 0.4s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(14px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .header-logo {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      margin-bottom: 24px;
    }
    .logo-icon {
      width: 46px;
      height: 46px;
      background: linear-gradient(135deg, #6366f1, #a855f7);
      border-radius: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 10px 20px -5px rgba(99, 102, 241, 0.5);
    }
    .card-title {
      font-size: 22px;
      font-weight: 800;
      text-align: center;
      margin-bottom: 8px;
      background: linear-gradient(135deg, #ffffff 40%, #c7d2fe 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .card-subtitle {
      font-size: 13px;
      color: var(--text-muted);
      text-align: center;
      margin-bottom: 28px;
      line-height: 1.5;
    }
    .form-group {
      margin-bottom: 20px;
      text-align: left;
    }
    .form-label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: #cbd5e1;
      margin-bottom: 8px;
    }
    .input-wrapper {
      position: relative;
      display: flex;
      align-items: center;
    }
    .input-icon {
      position: absolute;
      left: 14px;
      color: #64748b;
      pointer-events: none;
      display: flex;
      align-items: center;
    }
    .form-input {
      width: 100%;
      padding: 13px 14px 13px 44px;
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 14px;
      color: #fff;
      font-size: 14px;
      font-family: inherit;
      transition: all 0.2s;
    }
    .form-input:focus {
      outline: none;
      border-color: var(--primary-light);
      background: rgba(15, 23, 42, 0.9);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.25);
    }
    .toggle-pwd {
      position: absolute;
      right: 14px;
      background: none;
      border: none;
      color: #64748b;
      cursor: pointer;
      display: flex;
      align-items: center;
      padding: 4px;
    }
    .toggle-pwd:hover { color: #cbd5e1; }
    .btn-login {
      width: 100%;
      padding: 14px;
      margin-top: 10px;
      background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
      color: white;
      border: none;
      border-radius: 14px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s;
      box-shadow: 0 10px 25px -5px rgba(79, 70, 229, 0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .btn-login:hover {
      transform: translateY(-1px);
      box-shadow: 0 15px 30px -5px rgba(79, 70, 229, 0.5);
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
    }
    .btn-login:active { transform: translateY(0); }
    .btn-login:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    .alert-box {
      padding: 12px 14px;
      border-radius: 12px;
      font-size: 13px;
      margin-bottom: 20px;
      display: none;
      align-items: center;
      gap: 10px;
      animation: fadeIn 0.3s ease;
    }
    .alert-danger {
      background: rgba(244, 63, 94, 0.15);
      border: 1px solid rgba(244, 63, 94, 0.3);
      color: #fda4af;
    }
    .alert-success {
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: #6ee7b7;
    }
    .footer-link {
      margin-top: 24px;
      text-align: center;
      font-size: 12px;
      color: var(--text-muted);
    }
    .footer-link a {
      color: var(--primary-light);
      text-decoration: none;
      font-weight: 600;
    }
    .footer-link a:hover { text-decoration: underline; }
    .spin-loader {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      border-top-color: #fff;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="orb orb-1"></div>
  <div class="orb orb-2"></div>

  <div class="login-card">
    <div class="header-logo">
      <div class="logo-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
        </svg>
      </div>
    </div>

    <h1 class="card-title">Panel Trigger Sinkron</h1>
    <p class="card-subtitle">Masuk dengan kredensial terdaftar untuk mengontrol dan memicu sinkronisasi manual per wilayah.</p>

    <div id="login-alert" class="alert-box alert-danger"></div>

    <form id="login-form" onsubmit="handleLoginSubmit(event)">
      <div class="form-group">
        <label class="form-label" for="email">Email Administrator</label>
        <div class="input-wrapper">
          <span class="input-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
          </span>
          <input type="email" id="email" name="email" class="form-input" placeholder="admin@example.com" required autocomplete="email" autofocus>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="password">Password</label>
        <div class="input-wrapper">
          <span class="input-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
          </span>
          <input type="password" id="password" name="password" class="form-input" placeholder="••••••••••••" required autocomplete="current-password">
          <button type="button" class="toggle-pwd" onclick="togglePasswordVisibility()" title="Lihat password">
            <svg id="eye-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </div>
      </div>

      <button type="submit" id="btn-submit" class="btn-login">
        <span id="btn-text">Masuk ke Panel Kontrol</span>
      </button>
    </form>

    <div class="footer-link">
      <a href="/sync">Lihat Status Sinkronisasi Publik &rarr;</a>
    </div>
  </div>

  <script>
    function togglePasswordVisibility() {
      const pwd = document.getElementById('password');
      const eye = document.getElementById('eye-icon');
      if (pwd.type === 'password') {
        pwd.type = 'text';
        eye.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24M1 1l22 22"/>';
      } else {
        pwd.type = 'password';
        eye.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
      }
    }

    async function handleLoginSubmit(e) {
      e.preventDefault();
      const alertBox = document.getElementById('login-alert');
      const btn = document.getElementById('btn-submit');
      const btnText = document.getElementById('btn-text');
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;

      alertBox.style.display = 'none';
      btn.disabled = true;
      btnText.innerHTML = '<span class="spin-loader"></span> Memverifikasi...';

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });

        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Login gagal, periksa email dan password Anda.');
        }

        alertBox.className = 'alert-box alert-success';
        alertBox.innerText = 'Login berhasil! Mengalihkan ke panel kontrol...';
        alertBox.style.display = 'flex';

        setTimeout(() => {
          window.location.reload();
        }, 600);
      } catch (err) {
        alertBox.className = 'alert-box alert-danger';
        alertBox.innerText = err.message;
        alertBox.style.display = 'flex';
        btn.disabled = false;
        btnText.innerText = 'Masuk ke Panel Kontrol';
      }
    }
  </script>
</body>
</html>`;
}

// -------------------------------------------------------------------------------------------------
// 2. TAMPILAN DASHBOARD ADMIN (AUTHENTICATED MODE)
// -------------------------------------------------------------------------------------------------
function renderDashboard({
  session,
  compareList,
  activeRow,
  activeProvince,
  isRunning,
  selesai,
  lastChecked,
  clientSupabaseUrl,
  clientSupabaseAnonKey,
  initialQueue = [],
}) {
  const currentActiveProv = isRunning && !selesai ? activeProvince : null;
  const cleanActive = currentActiveProv ? cleanName(currentActiveProv) : null;

  const totalSynced = (activeRow?.total_baru || 0) + (activeRow?.total_diperbarui || 0) + (activeRow?.total_tidak_berubah || 0);
  const totalEstimasi = activeRow?.total_estimasi || totalSynced || 553831;
  const progressPercent = totalEstimasi > 0 ? Math.min(100, Math.round((totalSynced / totalEstimasi) * 100)) : 0;

  const compareRowsHtml = compareList.map((d, idx) => {
    const isThisProvActive = Boolean(isRunning && cleanActive && cleanName(d.nama) === cleanActive);
    const extraInDb = (d.total_db || 0) - (d.total_api || 0);

    let selisihColor = 'var(--danger)';
    let statusDisplay = '⚠️ Belum Sinkron';
    let selisihDisplay = `${d.selisih > 0 ? '+' : ''}${d.selisih.toLocaleString('id-ID')}`;

    if (d.raw_selisih === 0 && d.selisih === 0) {
      selisihColor = 'var(--success)';
      statusDisplay = '✅ Sinkron';
      selisihDisplay = '0';
    } else if (d.selisih === 0 && ((d.api_duplicates || 0) > 0 || (d.api_unrecognized_shapes || 0) > 0)) {
      selisihColor = 'var(--success)';
      statusDisplay = '✅ Sinkron';
      selisihDisplay = '0';
    } else if (extraInDb > 0) {
      selisihColor = 'var(--warning)';
      statusDisplay = '⚠️ Data Lebih di DB';
      selisihDisplay = `<span style="color: var(--warning);">+${extraInDb.toLocaleString('id-ID')} di DB</span>`;
    } else if (d.selisih > 0) {
      selisihColor = 'var(--danger)';
      statusDisplay = '⚠️ Belum Sinkron';
      selisihDisplay = `+${d.selisih.toLocaleString('id-ID')}`;
    } else if (d.selisih < 0) {
      selisihColor = 'var(--warning)';
      statusDisplay = '⚠️ Ada Selisih';
      selisihDisplay = `${d.selisih.toLocaleString('id-ID')}`;
    }

    const defaultStatus = statusDisplay;
    let statusCellHtml = statusDisplay;
    if (isThisProvActive) {
      statusCellHtml = '<span class="status-pill active-sync"><svg class="spin-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> Sedang Sinkron</span>';
    }

    const trClass = isThisProvActive ? 'row-active' : '';

    // Action button state
    let actionBtnHtml = '';
    const cleanD = cleanName(d.nama);
    const qIdx = (initialQueue || []).findIndex(q => cleanName(q.provinsi) === cleanD);
    const inQueue = qIdx !== -1;
    const queuePos = qIdx + 1;

    if (isThisProvActive) {
      actionBtnHtml = `<button class="btn-action btn-cancel" onclick="confirmCancelSync('${d.nama.replace(/'/g, "\\'")}')" title="Batalkan proses sinkronisasi ${d.nama}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 9l-6 6m0-6l6 6"/></svg> Batalkan Sinkron</button>`;
    } else if (inQueue) {
      actionBtnHtml = `<div class="queue-action-group">
        <span class="badge-queue"><span class="queue-pulse"></span> Antrian #${queuePos}</span>
        <button class="btn-cancel-queue" onclick="executeCancelQueue('${d.nama.replace(/'/g, "\\'")}')" title="Batalkan antrean ${d.nama}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg> Batal Antrian</button>
      </div>`;
    } else if (isRunning) {
      actionBtnHtml = `<button class="btn-action btn-add-queue" onclick="executeAddToQueue('${d.nama.replace(/'/g, "\\'")}')" title="Tambahkan ${d.nama} ke antrean sinkronisasi berikutnya"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg> + Antrian</button>`;
    } else {
      actionBtnHtml = `<button class="btn-action btn-trigger" onclick="confirmTriggerSync('${d.nama.replace(/'/g, "\\'")}')" title="Picu GitHub Action untuk ${d.nama}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg> Sinkronkan</button>`;
    }

    return `
      <tr class="${trClass}" data-prov="${cleanName(d.nama)}">
        <td style="text-align: center; color: var(--text-muted); font-size: 12px; font-weight: 600;">${idx + 1}</td>
        <td>
          <div style="font-weight: 700; color: var(--text-main);">${d.nama}</div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">Kode: ${d.kode}</div>
        </td>
        <td style="text-align: center; font-weight: 600; color: var(--info); font-size: 14px;">
          ${(d.total_api || 0).toLocaleString('id-ID')}
        </td>
        <td style="text-align: center; font-weight: 600; color: var(--primary-light); font-size: 14px;">
          ${(d.total_db || 0).toLocaleString('id-ID')}
        </td>
        <td style="text-align: center; font-weight: 700; color: ${selisihColor}; font-size: 14px;">
          ${selisihDisplay}
        </td>
        <td class="compare-status-cell" data-default-status="${defaultStatus.replace(/"/g, '&quot;')}" style="text-align: center; color: ${selisihColor}; font-size: 12px; font-weight: 600;">
          ${statusCellHtml}
        </td>
        <td class="action-cell" style="text-align: center;">
          ${actionBtnHtml}
        </td>
      </tr>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Panel Manual Trigger Sinkronisasi — EduAPI</title>
  <link rel="icon" href="/favicon-sync.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  <style>
    :root {
      --bg: #07090e;
      --card-bg: rgba(17, 24, 39, 0.75);
      --card-border: rgba(255, 255, 255, 0.08);
      --primary: #6366f1;
      --primary-light: #818cf8;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --text-subtle: #cbd5e1;
      --info: #38bdf8;
      --danger: #fb7185;
      --warning: #f59e0b;
      --success: #34d399;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      background: radial-gradient(circle at 50% 0%, #151632 0%, #080b12 60%, #030408 100%);
      min-height: 100vh;
      color: var(--text-main);
      padding: 24px;
      overflow-x: hidden;
    }
    .container {
      max-width: 1240px;
      margin: 0 auto;
    }
    /* Top Navbar */
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      padding: 16px 20px;
      background: rgba(15, 23, 42, 0.65);
      border: 1px solid var(--card-border);
      backdrop-filter: blur(20px);
      border-radius: 20px;
      margin-bottom: 24px;
    }
    .topbar-brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-icon {
      width: 38px;
      height: 38px;
      background: linear-gradient(135deg, #6366f1, #a855f7);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 14px rgba(99, 102, 241, 0.4);
    }
    .brand-title {
      font-size: 16px;
      font-weight: 800;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .badge-admin {
      font-size: 10px;
      text-transform: uppercase;
      background: rgba(99, 102, 241, 0.25);
      color: #a5b4fc;
      border: 1px solid rgba(129, 140, 248, 0.4);
      padding: 2px 7px;
      border-radius: 6px;
      font-weight: 700;
    }
    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .user-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: #cbd5e1;
      background: rgba(255, 255, 255, 0.05);
      padding: 6px 12px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .btn-topbar {
      padding: 7px 14px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
      text-decoration: none;
      border: 1px solid transparent;
    }
    .btn-token {
      background: rgba(56, 189, 248, 0.15);
      color: #38bdf8;
      border-color: rgba(56, 189, 248, 0.3);
    }
    .btn-token:hover { background: rgba(56, 189, 248, 0.25); }
    .btn-public {
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-subtle);
      border-color: var(--card-border);
    }
    .btn-public:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }
    .btn-logout {
      background: rgba(244, 63, 94, 0.15);
      color: #fb7185;
      border-color: rgba(244, 63, 94, 0.3);
    }
    .btn-logout:hover { background: rgba(244, 63, 94, 0.25); }

    /* Live Card */
    .status-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      backdrop-filter: blur(20px);
      border-radius: 20px;
      padding: 22px 24px;
      margin-bottom: 24px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
    }
    .status-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 16px;
    }
    .live-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      border-radius: 9999px;
      font-size: 13px;
      font-weight: 700;
    }
    .live-badge.running {
      background: rgba(99, 102, 241, 0.2);
      color: #c7d2fe;
      border: 1px solid rgba(129, 140, 248, 0.5);
      box-shadow: 0 0 15px rgba(99, 102, 241, 0.3);
    }
    .live-badge.idle {
      background: rgba(16, 185, 129, 0.15);
      color: #6ee7b7;
      border: 1px solid rgba(16, 185, 129, 0.4);
    }
    .pulse-dot {
      width: 8px;
      height: 8px;
      background: #818cf8;
      border-radius: 50%;
      box-shadow: 0 0 8px #818cf8;
      animation: pulseGlow 1.5s infinite;
    }
    @keyframes pulseGlow {
      0% { transform: scale(0.9); opacity: 0.7; }
      50% { transform: scale(1.3); opacity: 1; }
      100% { transform: scale(0.9); opacity: 0.7; }
    }
    .notice-box {
      background: rgba(99, 102, 241, 0.08);
      border: 1px solid rgba(99, 102, 241, 0.2);
      border-radius: 12px;
      padding: 12px 16px;
      font-size: 13px;
      color: #c7d2fe;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    /* Table Section */
    .table-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      backdrop-filter: blur(20px);
      border-radius: 24px;
      padding: 24px;
      box-shadow: 0 15px 35px rgba(0, 0, 0, 0.4);
    }
    .table-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      margin-bottom: 20px;
    }
    .table-title {
      font-size: 18px;
      font-weight: 800;
      display: flex;
      align-items: center;
      gap: 10px;
      color: #fff;
    }
    .search-input {
      padding: 10px 14px;
      background: rgba(15, 23, 42, 0.7);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      color: #fff;
      font-size: 13px;
      width: 260px;
      outline: none;
      transition: all 0.2s;
    }
    .search-input:focus {
      border-color: var(--primary-light);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
    }
    .custom-table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }
    .custom-table th {
      padding: 14px 12px;
      font-size: 12px;
      font-weight: 700;
      color: #94a3b8;
      text-transform: uppercase;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      letter-spacing: 0.03em;
    }
    .custom-table td {
      padding: 14px 12px;
      font-size: 13px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      vertical-align: middle;
    }
    .custom-table tr:hover {
      background: rgba(255, 255, 255, 0.02);
    }
    .custom-table tr.row-active {
      background: linear-gradient(90deg, rgba(99, 102, 241, 0.18) 0%, rgba(236, 72, 153, 0.12) 100%) !important;
      border-left: 3px solid #818cf8 !important;
    }

    /* Status Pill & Spin */
    .status-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 9999px;
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .status-pill.active-sync {
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.25), rgba(236, 72, 153, 0.25));
      color: #e0e7ff;
      border: 1px solid rgba(129, 140, 248, 0.5);
      box-shadow: 0 0 12px rgba(99, 102, 241, 0.3);
      padding: 5px 12px;
    }
    .status-pill.active-sync .spin-icon {
      color: #818cf8;
      filter: drop-shadow(0 0 4px #818cf8);
    }
    .spin-icon {
      display: inline-block;
      animation: rotation 1.4s linear infinite;
    }
    @keyframes rotation {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    /* Action Buttons */
    .btn-action {
      padding: 8px 14px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 700;
      border: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
    }
    .btn-trigger {
      background: linear-gradient(135deg, #4f46e5, #7c3aed);
      color: #fff;
      box-shadow: 0 4px 14px rgba(79, 70, 229, 0.35);
    }
    .btn-trigger:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 18px rgba(79, 70, 229, 0.5);
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
    }
    .btn-disabled {
      background: rgba(255, 255, 255, 0.05);
      color: rgba(255, 255, 255, 0.35);
      border: 1px solid rgba(255, 255, 255, 0.08);
      cursor: not-allowed;
      pointer-events: none;
    }
    .btn-syncing {
      background: rgba(99, 102, 241, 0.2);
      color: #a5b4fc;
      border: 1px solid rgba(129, 140, 248, 0.4);
      cursor: not-allowed;
    }
    .btn-cancel {
      background: linear-gradient(135deg, #e11d48, #be123c);
      color: #fff;
      box-shadow: 0 4px 14px rgba(225, 29, 72, 0.35);
    }
    .btn-cancel:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 18px rgba(225, 29, 72, 0.5);
      background: linear-gradient(135deg, #f43f5e, #e11d48);
    }
    .btn-add-queue {
      background: linear-gradient(135deg, #0284c7, #0369a1);
      color: #fff;
      box-shadow: 0 4px 14px rgba(2, 132, 199, 0.35);
    }
    .btn-add-queue:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 18px rgba(2, 132, 199, 0.5);
      background: linear-gradient(135deg, #0ea5e9, #0284c7);
    }
    .queue-action-group {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-wrap: nowrap;
    }
    .badge-queue {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 8px;
      background: rgba(245, 158, 11, 0.15);
      border: 1px solid rgba(245, 158, 11, 0.45);
      color: #fbbf24;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.02em;
      white-space: nowrap;
      box-shadow: 0 0 10px rgba(245, 158, 11, 0.15);
    }
    .queue-pulse {
      width: 6px;
      height: 6px;
      background: #fbbf24;
      border-radius: 50%;
      box-shadow: 0 0 6px #fbbf24;
      animation: pulseGlow 1.5s infinite;
    }
    .btn-cancel-queue {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 5px 9px;
      border-radius: 8px;
      background: rgba(244, 63, 94, 0.12);
      border: 1px solid rgba(244, 63, 94, 0.35);
      color: #fda4af;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .btn-cancel-queue:hover {
      background: rgba(244, 63, 94, 0.25);
      border-color: #f43f5e;
      color: #fff;
      transform: translateY(-1px);
    }
    .sync-option-card {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 12px 14px;
      cursor: pointer;
      transition: all 0.2s;
    }
    .sync-option-card:hover {
      background: rgba(255, 255, 255, 0.06);
      border-color: rgba(255, 255, 255, 0.15);
    }
    .sync-option-card.active {
      background: rgba(99, 102, 241, 0.12);
      border-color: rgba(129, 140, 248, 0.45);
      box-shadow: 0 0 12px rgba(99, 102, 241, 0.15);
    }

    /* Modal Styles */
    .modal-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 100;
      padding: 20px;
    }
    .modal-box {
      background: #0f172a;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 20px;
      max-width: 480px;
      width: 100%;
      padding: 28px;
      box-shadow: 0 25px 50px rgba(0, 0, 0, 0.6);
      animation: fadeIn 0.25s ease-out;
    }
    .modal-title {
      font-size: 18px;
      font-weight: 800;
      color: #fff;
      margin-bottom: 8px;
    }
    .modal-desc {
      font-size: 13px;
      color: #94a3b8;
      line-height: 1.5;
      margin-bottom: 20px;
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 24px;
    }
    .btn-modal-cancel {
      padding: 9px 16px;
      background: rgba(255, 255, 255, 0.08);
      color: #cbd5e1;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 10px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-modal-cancel:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }
    .btn-modal-confirm {
      padding: 9px 18px;
      background: linear-gradient(135deg, #4f46e5, #7c3aed);
      color: #fff;
      border: none;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
    }
    .btn-modal-confirm:hover { background: linear-gradient(135deg, #6366f1, #8b5cf6); }

    /* Toast Notification */
    #toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 200;
      padding: 14px 20px;
      border-radius: 14px;
      font-size: 13px;
      font-weight: 600;
      display: none;
      align-items: center;
      gap: 10px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
      animation: fadeIn 0.3s ease;
    }
    .toast-success {
      background: #064e3b;
      color: #a7f3d0;
      border: 1px solid #059669;
    }
    .toast-danger {
      background: #881337;
      color: #fecdd3;
      border: 1px solid #e11d48;
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Topbar -->
    <div class="topbar">
      <div class="topbar-brand">
        <div class="brand-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
        </div>
        <div>
          <div class="brand-title">
            EduAPI Control Panel
            <span class="badge-admin">Admin</span>
          </div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">Trigger Manual Sinkronisasi Provinsi</div>
        </div>
      </div>

      <div class="topbar-actions">
        <div class="user-pill">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          <span>${maskEmail(session.email)}</span>
        </div>

        <button class="btn-topbar btn-token" onclick="openTokenModal()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-1.5 1.5L14 9l-3-3 2.5-2.5L16 1l5 5z"/><path d="M11 11l-8 8v3h3l8-8"/></svg>
          <span id="token-status-text">Token GitHub</span>
        </button>

        <a href="/sync" class="btn-topbar btn-public" target="_blank">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          Live Dashboard
        </a>

        <a href="/api/auth/logout" class="btn-topbar btn-logout">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          Keluar
        </a>
      </div>
    </div>

    <!-- Status Card -->
    <div class="status-card">
      <div class="status-header">
        <div>
          <div style="font-size: 12px; color: var(--text-muted); text-transform: uppercase; font-weight: 700; margin-bottom: 4px;">Status Sinkronisasi Sistem</div>
          <div id="live-state-wrapper">
            ${isRunning ? `
              <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                <div class="live-badge running">
                  <span class="pulse-dot"></span>
                  <span>Sedang Menyinkronkan — <strong>${activeProvince || 'Semua Wilayah'}</strong></span>
                </div>
                <button class="btn-action btn-cancel" style="padding: 5px 12px; font-size: 11px;" onclick="confirmCancelSync('${(activeProvince || '').replace(/'/g, "\\'")}')" title="Hentikan dan batalkan proses sinkronisasi">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 9l-6 6m0-6l6 6"/></svg>
                  Batalkan Sinkron
                </button>
              </div>
            ` : `
              <div class="live-badge idle">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
                <span>Sistem Siap (Idle) — Dapat Memulai Sinkronisasi Manual</span>
              </div>
            `}
          </div>
        </div>

        <div style="text-align: right; font-size: 12px; color: var(--text-muted);">
          Update Terakhir Cache: <strong style="color: var(--text-subtle);">${lastChecked}</strong>
        </div>
      </div>

      <div class="notice-box">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2" style="shrink-0;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span>
          <strong>Kebijakan Sinkronisasi Tunggal:</strong> Hanya 1 provinsi yang dapat disinkronkan dalam satu waktu. Jika sinkronisasi sedang berlangsung, Anda dapat membatalkannya kapan saja menggunakan tombol <strong>Batalkan Sinkron</strong>. Saat memulai sinkronisasi, Anda dapat memilih antara melanjutkan posisi terakhir atau memulai dari awal (reset offset).
        </span>
      </div>
    </div>

    <!-- Table Card -->
    <div class="table-card">
      <div class="table-top">
        <div class="table-title">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>
          Perbandingan Data & Aksi Manual (39 Provinsi)
        </div>

        <div>
          <input type="text" id="prov-search" class="search-input" placeholder="🔍 Cari provinsi..." oninput="filterProvinces()">
        </div>
      </div>

      <div style="overflow-x: auto;">
        <table class="custom-table" id="table-provinces">
          <thead>
            <tr>
              <th style="text-align: center; width: 45px;">No</th>
              <th>Provinsi</th>
              <th style="text-align: center;">Data Pusat</th>
              <th style="text-align: center;">Database</th>
              <th style="text-align: center;">Selisih</th>
              <th style="text-align: center;">Status</th>
              <th style="text-align: center; width: 140px;">Aksi Manual</th>
            </tr>
          </thead>
          <tbody id="prov-tbody">
            ${compareRowsHtml}
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- Modal Konfirmasi Trigger & Pilihan Mode -->
  <div id="modal-confirm" class="modal-overlay">
    <div class="modal-box">
      <div class="modal-title">Konfirmasi Sinkronisasi Manual</div>
      <p class="modal-desc">
        Picu sinkronisasi manual untuk provinsi <strong id="modal-prov-name" style="color: #38bdf8;">-</strong>. Pilih metode sinkronisasi di bawah ini:
      </p>

      <div style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 18px;">
        <label class="sync-option-card active" id="card-mode-resume" onclick="selectSyncMode('resume')">
          <input type="radio" name="sync-mode" value="resume" checked style="accent-color: #6366f1; width: 16px; height: 16px; margin-top: 2px; cursor: pointer;">
          <div style="flex: 1;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="font-weight: 700; font-size: 13px; color: #fff;">Lanjutkan Sinkron</span>
              <span style="font-size: 10px; font-weight: 700; background: rgba(16, 185, 129, 0.2); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.4); padding: 1px 6px; border-radius: 4px;">Rekomendasi</span>
            </div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px; line-height: 1.4;">
              Melanjutkan dari posisi terakhir (bentuk pendidikan & offset yang tersimpan). Menghemat kuota dan waktu jika sinkronisasi sebelumnya sempat terhenti.
            </div>
          </div>
        </label>

        <label class="sync-option-card" id="card-mode-fresh" onclick="selectSyncMode('fresh')">
          <input type="radio" name="sync-mode" value="fresh" style="accent-color: #6366f1; width: 16px; height: 16px; margin-top: 2px; cursor: pointer;">
          <div style="flex: 1;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="font-weight: 700; font-size: 13px; color: #fff;">Mulai dari Awal</span>
              <span style="font-size: 10px; font-weight: 700; background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); padding: 1px 6px; border-radius: 4px;">Reset ke 0</span>
            </div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px; line-height: 1.4;">
              Mereset offset dan jenjang ke awal (TK, offset 0). Mengambil dan memperbarui ulang seluruh data sekolah provinsi ini dari nol.
            </div>
          </div>
        </label>
      </div>

      <div style="background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.25); border-radius: 10px; padding: 10px 14px; font-size: 12px; color: #fbbf24; margin-bottom: 20px;">
        ⚠️ Selama proses berjalan, sinkronisasi untuk provinsi lain akan dikunci hingga proses ini selesai atau dibatalkan.
      </div>
      <div class="modal-actions">
        <button class="btn-modal-cancel" onclick="closeTriggerModal()">Batal</button>
        <button id="btn-do-trigger" class="btn-modal-confirm" onclick="executeTriggerSync()">Mulai Sinkronkan</button>
      </div>
    </div>
  </div>

  <!-- Modal Konfirmasi Batalkan Sinkron -->
  <div id="modal-cancel-confirm" class="modal-overlay">
    <div class="modal-box">
      <div class="modal-title" style="display: flex; align-items: center; gap: 8px; color: #fb7185;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
        Batalkan Sinkronisasi
      </div>
      <p class="modal-desc">
        Apakah Anda yakin ingin menghentikan dan membatalkan proses sinkronisasi untuk provinsi <strong id="cancel-modal-prov-name" style="color: #38bdf8;">-</strong>?
      </p>
      <div style="background: rgba(244, 63, 94, 0.1); border: 1px solid rgba(244, 63, 94, 0.3); border-radius: 10px; padding: 12px 14px; font-size: 12px; color: #fda4af; line-height: 1.5; margin-bottom: 18px;">
        ⚠️ <strong>Efek Pembatalan:</strong>
        <ul style="margin: 6px 0 0 16px;">
          <li>Workflow run di GitHub Actions akan langsung dibatalkan (dihentikan).</li>
          <li>Status sistem segera kembali ke <strong>Siap (Idle)</strong> dan tombol sinkron akan aktif kembali.</li>
          <li>Data yang telah tersimpan di database sebelum pembatalan tetap aman.</li>
        </ul>
      </div>
      <div class="modal-actions">
        <button class="btn-modal-cancel" onclick="closeCancelModal()">Kembali</button>
        <button id="btn-do-cancel" class="btn-action btn-cancel" style="padding: 9px 18px; font-size: 13px;" onclick="executeCancelSync()">Ya, Batalkan Sinkron</button>
      </div>
    </div>
  </div>

  <!-- Modal Pengaturan Token GitHub -->
  <div id="modal-token" class="modal-overlay">
    <div class="modal-box">
      <div class="modal-title">Pengaturan Token GitHub</div>
      <p class="modal-desc">
        Token Personal Access Token (PAT) dengan hak akses <code>actions:write</code> / <code>repo</code> diperlukan untuk memicu GitHub Actions dari panel web ini.
      </p>
      <div style="margin-bottom: 16px;">
        <label style="display: block; font-size: 12px; font-weight: 600; color: #cbd5e1; margin-bottom: 6px;">GitHub Personal Access Token</label>
        <input type="password" id="input-token" class="search-input" style="width: 100%;" placeholder="ghp_xxxxxxxxxxxx atau github_pat_xxxxxxxxxxxx">
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 6px;">
          Token akan disimpan secara aman di database. <a href="https://github.com/settings/tokens/new" target="_blank" style="color: #38bdf8;">Buat token di GitHub &rarr;</a>
        </div>
      </div>
      <div id="token-alert" style="display: none; padding: 10px; border-radius: 8px; font-size: 12px; margin-bottom: 12px;"></div>
      <div class="modal-actions">
        <button class="btn-modal-cancel" onclick="closeTokenModal()">Tutup</button>
        <button id="btn-save-token" class="btn-modal-confirm" onclick="saveGithubToken()">Simpan Token</button>
      </div>
    </div>
  </div>

  <!-- Toast Notification -->
  <div id="toast"></div>

  <script>
    let selectedProv = null;
    let isCurrentlyRunning = ${isRunning ? 'true' : 'false'};
    let currentQueue = ${JSON.stringify(initialQueue || [])};

    function showToast(msg, isSuccess = true) {
      const toast = document.getElementById('toast');
      toast.className = isSuccess ? 'toast-success' : 'toast-danger';
      toast.innerHTML = (isSuccess ? '✅ ' : '❌ ') + msg;
      toast.style.display = 'flex';
      setTimeout(() => { toast.style.display = 'none'; }, 4000);
    }

    function selectSyncMode(mode) {
      const radio = document.querySelector('input[name="sync-mode"][value="' + mode + '"]');
      if (radio) radio.checked = true;
      document.getElementById('card-mode-resume')?.classList.toggle('active', mode === 'resume');
      document.getElementById('card-mode-fresh')?.classList.toggle('active', mode === 'fresh');
    }

    function confirmTriggerSync(provName) {
      if (isCurrentlyRunning) {
        showToast('Sinkronisasi lain sedang berjalan. Harap tunggu hingga selesai atau batalkan terlebih dahulu.', false);
        return;
      }
      selectedProv = provName;
      document.getElementById('modal-prov-name').innerText = provName;
      selectSyncMode('resume');
      document.getElementById('modal-confirm').style.display = 'flex';
    }

    function closeTriggerModal() {
      document.getElementById('modal-confirm').style.display = 'none';
      selectedProv = null;
    }

    async function executeTriggerSync() {
      if (!selectedProv) return;
      const btn = document.getElementById('btn-do-trigger');
      btn.disabled = true;
      btn.innerText = 'Memproses...';

      const modeInput = document.querySelector('input[name="sync-mode"]:checked');
      const isMulaiAwal = modeInput ? (modeInput.value === 'fresh') : false;

      try {
        const res = await fetch('/api/trigger-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provinsi: selectedProv,
            mulai_dari_awal: isMulaiAwal
          })
        });

        const data = await res.json();
        if (!res.ok || !data.ok) {
          if (data.need_token) {
            closeTriggerModal();
            openTokenModal();
            throw new Error(data.error);
          }
          throw new Error(data.error || 'Gagal memicu sinkronisasi.');
        }

        closeTriggerModal();
        const modeLabel = isMulaiAwal ? ' (Mulai dari Awal)' : ' (Lanjutkan)';
        showToast('Berhasil memicu sinkronisasi untuk ' + selectedProv + modeLabel + '!');

        // Update state lokal seketika
        isCurrentlyRunning = true;
        updateButtonsState(true, selectedProv);
        pollSyncStatus();
      } catch (err) {
        btn.disabled = false;
        btn.innerText = 'Mulai Sinkronkan';
        showToast(err.message, false);
      }
    }

    // Modal Cancel Sync
    let cancelTargetProv = null;
    let cancelCooldownUntil = 0;
    function confirmCancelSync(provName) {
      cancelTargetProv = provName || 'yang sedang berjalan';
      const el = document.getElementById('cancel-modal-prov-name');
      if (el) el.innerText = cancelTargetProv;
      const modal = document.getElementById('modal-cancel-confirm');
      if (modal) {
        modal.style.display = 'flex';
        setTimeout(() => {
          document.getElementById('btn-do-cancel')?.focus();
        }, 50);
      }
    }

    function closeCancelModal() {
      document.getElementById('modal-cancel-confirm').style.display = 'none';
      cancelTargetProv = null;
    }

    async function executeCancelSync() {
      const btn = document.getElementById('btn-do-cancel');
      btn.disabled = true;
      btn.innerText = 'Membatalkan...';

      try {
        const res = await fetch('/api/cancel-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });

        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Gagal membatalkan sinkronisasi.');
        }

        closeCancelModal();
        showToast(data.message || 'Sinkronisasi berhasil dibatalkan!');

        // Update state lokal seketika agar tombol kembali ke Sinkronkan dan tahan selama 6 detik dari polling
        isCurrentlyRunning = false;
        cancelCooldownUntil = Date.now() + 6000;
        updateButtonsState(false, null);
        setTimeout(pollSyncStatus, 1500);
      } catch (err) {
        showToast(err.message, false);
      } finally {
        btn.disabled = false;
        btn.innerText = 'Ya, Batalkan Sinkron';
      }
    // Antrean Sinkronisasi (Queue)
    async function executeAddToQueue(provName) {
      const tr = document.querySelector('tr[data-prov="' + cleanName(provName) + '"]');
      const actionCell = tr?.querySelector('.action-cell');
      if (actionCell) {
        actionCell.innerHTML = '<span style="font-size: 11px; color: #38bdf8; font-weight: 700;"><span class="spin-icon" style="display:inline-block; vertical-align:middle; margin-right:4px;">🔄</span> Menambahkan...</span>';
      }

      try {
        const res = await fetch('/api/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'add', provinsi: provName, mulai_dari_awal: false })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Gagal menambahkan ke antrean');
        }
        showToast(data.message || (provName + ' masuk antrean #' + data.queue_index));
        currentQueue = data.queue || [];
        updateButtonsState(isCurrentlyRunning, null, currentQueue);
      } catch (err) {
        showToast(err.message, false);
        updateButtonsState(isCurrentlyRunning, null, currentQueue);
      }
    }

    async function executeCancelQueue(provName) {
      const tr = document.querySelector('tr[data-prov="' + cleanName(provName) + '"]');
      const actionCell = tr?.querySelector('.action-cell');
      if (actionCell) {
        actionCell.innerHTML = '<span style="font-size: 11px; color: #fb7185; font-weight: 700;"><span class="spin-icon" style="display:inline-block; vertical-align:middle; margin-right:4px;">🔄</span> Membatalkan...</span>';
      }

      try {
        const res = await fetch('/api/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'remove', provinsi: provName })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Gagal membatalkan antrean');
        }
        showToast(data.message || ('Antrean untuk ' + provName + ' dibatalkan'));
        currentQueue = data.queue || [];
        updateButtonsState(isCurrentlyRunning, null, currentQueue);
      } catch (err) {
        showToast(err.message, false);
        updateButtonsState(isCurrentlyRunning, null, currentQueue);
      }
    }

    // Modal Token
    function openTokenModal() {
      document.getElementById('token-alert').style.display = 'none';
      document.getElementById('modal-token').style.display = 'flex';
      checkTokenStatus();
    }

    function closeTokenModal() {
      document.getElementById('modal-token').style.display = 'none';
    }

    async function checkTokenStatus() {
      try {
        const res = await fetch('/api/github-token');
        const data = await res.json();
        const alertEl = document.getElementById('token-alert');
        const statusText = document.getElementById('token-status-text');
        if (data.configured) {
          alertEl.style.display = 'block';
          alertEl.style.background = 'rgba(16, 185, 129, 0.15)';
          alertEl.style.color = '#6ee7b7';
          alertEl.style.border = '1px solid rgba(16, 185, 129, 0.3)';
          alertEl.innerText = '✅ Token GitHub telah terkonfigurasi (Sumber: ' + data.source + '). Anda dapat menimpanya jika perlu.';
          if (statusText) statusText.innerText = 'Token: Aktif ✅';
        } else {
          alertEl.style.display = 'block';
          alertEl.style.background = 'rgba(244, 63, 94, 0.15)';
          alertEl.style.color = '#fda4af';
          alertEl.style.border = '1px solid rgba(244, 63, 94, 0.3)';
          alertEl.innerText = '⚠️ Token GitHub belum terpasang. Harap masukkan token untuk dapat memicu sinkronisasi.';
          if (statusText) statusText.innerText = 'Token: Belum Ada ⚠️';
        }
      } catch (e) {}
    }

    async function saveGithubToken() {
      const token = document.getElementById('input-token').value.trim();
      const alertEl = document.getElementById('token-alert');
      const btn = document.getElementById('btn-save-token');

      if (!token) {
        alertEl.style.display = 'block';
        alertEl.style.background = 'rgba(244, 63, 94, 0.15)';
        alertEl.style.color = '#fda4af';
        alertEl.innerText = 'Token tidak boleh kosong.';
        return;
      }

      btn.disabled = true;
      btn.innerText = 'Menyimpan...';

      try {
        const res = await fetch('/api/github-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Gagal menyimpan token');

        alertEl.style.display = 'block';
        alertEl.style.background = 'rgba(16, 185, 129, 0.15)';
        alertEl.style.color = '#6ee7b7';
        alertEl.innerText = '✅ ' + data.message;
        document.getElementById('input-token').value = '';
        checkTokenStatus();
        setTimeout(closeTokenModal, 1200);
      } catch (err) {
        alertEl.style.display = 'block';
        alertEl.style.background = 'rgba(244, 63, 94, 0.15)';
        alertEl.style.color = '#fda4af';
        alertEl.innerText = err.message;
      } finally {
        btn.disabled = false;
        btn.innerText = 'Simpan Token';
      }
    }

    // Filter Provinsi
    function filterProvinces() {
      const q = document.getElementById('prov-search').value.toLowerCase();
      const rows = document.querySelectorAll('#prov-tbody tr');
      rows.forEach(tr => {
        const name = tr.querySelector('td:nth-child(2)')?.innerText.toLowerCase() || '';
        tr.style.display = name.includes(q) ? '' : 'none';
      });
    }

    // Update Button States Realtime
    function updateButtonsState(running, activeProvName, queueList = null) {
      isCurrentlyRunning = running;
      if (queueList !== null && Array.isArray(queueList)) {
        currentQueue = queueList;
      }
      const cleanAct = activeProvName ? activeProvName.replace(/[^A-Z0-9]/gi, '').toUpperCase().replace(/^PROVINSI|^PROV/, '') : null;
      const liveWrapper = document.getElementById('live-state-wrapper');

      if (liveWrapper) {
        let queueBadgesHtml = '';
        if (currentQueue && currentQueue.length > 0) {
          queueBadgesHtml = '<div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 8px; font-size: 11px; color: #cbd5e1;">' +
            '<span style="color: #fbbf24; font-weight: 700;">Antrean Menanti:</span>' +
            currentQueue.map((q, idx) => '<span class="badge-queue" style="padding: 3px 8px; font-size: 10px;">#' + (idx + 1) + ' ' + q.provinsi + '</span>').join(' ') +
            '</div>';
        }

        if (running) {
          const safeActStr = (activeProvName || '').replace(/'/g, "\\'");
          liveWrapper.innerHTML = '<div>' +
            '<div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">' +
            '<div class="live-badge running"><span class="pulse-dot"></span><span>Sedang Menyinkronkan — <strong>' + (activeProvName || 'Semua Wilayah') + '</strong></span></div>' +
            '<button class="btn-action btn-cancel" style="padding: 5px 12px; font-size: 11px;" onclick="confirmCancelSync(\'' + safeActStr + '\')" title="Hentikan dan batalkan proses sinkronisasi">' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 9l-6 6m0-6l6 6"/></svg> Batalkan Sinkron</button>' +
            '</div>' +
            queueBadgesHtml +
            '</div>';
        } else {
          liveWrapper.innerHTML = '<div>' +
            '<div class="live-badge idle"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg><span>Sistem Siap (Idle) — Dapat Memulai Sinkronisasi Manual</span></div>' +
            queueBadgesHtml +
            '</div>';
        }
      }

      const rows = document.querySelectorAll('#prov-tbody tr[data-prov]');
      rows.forEach(tr => {
        const p = tr.getAttribute('data-prov');
        const statusCell = tr.querySelector('.compare-status-cell');
        const actionCell = tr.querySelector('.action-cell');
        if (!statusCell || !actionCell) return;

        const isThis = cleanAct && (p === cleanAct);
        const rawProv = tr.querySelector('td:nth-child(2) div:first-child')?.innerText || '';
        const safeRawProv = rawProv.replace(/'/g, "\\'");

        // Cek posisi di antrean
        const qIdx = (currentQueue || []).findIndex(q => cleanName(q.provinsi) === p);
        const inQueue = qIdx !== -1;
        const queuePos = qIdx + 1;

        if (isThis) {
          tr.classList.add('row-active');
          statusCell.innerHTML = '<span class="status-pill active-sync"><svg class="spin-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> Sedang Sinkron</span>';
          actionCell.innerHTML = '<button class="btn-action btn-cancel" onclick="confirmCancelSync(\'' + safeRawProv + '\')" title="Batalkan sinkronisasi ' + rawProv + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 9l-6 6m0-6l6 6"/></svg> Batalkan Sinkron</button>';
        } else {
          tr.classList.remove('row-active');
          if (statusCell.hasAttribute('data-default-status')) {
            statusCell.innerHTML = statusCell.getAttribute('data-default-status');
          }

          if (inQueue) {
            actionCell.innerHTML = '<div class="queue-action-group">' +
              '<span class="badge-queue"><span class="queue-pulse"></span> Antrian #' + queuePos + '</span>' +
              '<button class="btn-cancel-queue" onclick="executeCancelQueue(\'' + safeRawProv + '\')" title="Batalkan antrean ' + rawProv + '"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg> Batal Antrian</button>' +
              '</div>';
          } else if (running) {
            actionCell.innerHTML = '<button class="btn-action btn-add-queue" onclick="executeAddToQueue(\'' + safeRawProv + '\')" title="Tambahkan ' + rawProv + ' ke antrean sinkronisasi berikutnya"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg> + Antrian</button>';
          } else {
            actionCell.innerHTML = '<button class="btn-action btn-trigger" onclick="confirmTriggerSync(\'' + safeRawProv + '\')" title="Picu GitHub Action untuk ' + rawProv + '"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg> Sinkronkan</button>';
          }
        }
      });
    }

    // Polling Status Realtime
    async function pollSyncStatus() {
      if (Date.now() < cancelCooldownUntil) {
        setTimeout(pollSyncStatus, 2000);
        return;
      }
      try {
        const res = await fetch('/api/sync-status?_t=' + Date.now(), { cache: 'no-store' });
        if (res.ok) {
          const status = await res.json();
          if (status && status.ok) {
            const running = Boolean(status.isRunning && !status.selesai);
            const actProv = running ? (status.activeProvince || (status.bentukBerikutnya && status.bentukBerikutnya.match(/\\((.*?)\\)/)?.[1])) : null;
            const qList = Array.isArray(status.queue) ? status.queue : currentQueue;
            updateButtonsState(running, actProv, qList);
          }
        }
      } catch (e) {}

      setTimeout(pollSyncStatus, isCurrentlyRunning ? 2500 : 5000);
    }

    // Supabase Realtime WebSocket
    const clientSupabaseUrl = "${clientSupabaseUrl}";
    const clientSupabaseAnonKey = "${clientSupabaseAnonKey}";
    if (window.supabase && clientSupabaseUrl && clientSupabaseAnonKey) {
      try {
        const sb = window.supabase.createClient(clientSupabaseUrl, clientSupabaseAnonKey);
        sb.channel('realtime-login-sync')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'status_sinkronisasi' }, function() {
            pollSyncStatus();
          })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'cache_data' }, function(payload) {
            if (payload?.new?.key === 'sync_queue') pollSyncStatus();
          })
          .subscribe();
      } catch (err) {}
    }

    // Init check
    checkTokenStatus();
    setTimeout(pollSyncStatus, 2500);
  </script>
</body>
</html>`;
}
