import {
  getApiMeta,
  getSyncProgress,
  getCronHeartbeat,
  formatSyncTimeWib,
  resolveSyncRunState,
  markSyncStalled,
  isChunkLocked,
} from './sync-meta.js';
import { ESTIMATED_TOTAL_RECORDS, progressPercent } from './sync-sekolah.js';
import { getActivityLog, activityKindLabel } from './sync-activity-log.js';
import { getRowFpStatsForReport, PAGES_BACKFILL_URL } from './backfill-row-fp.js';

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {{ lastChunk?: object }} [opts]
 */
export async function buildSyncStatusReport(db, { lastChunk } = {}) {
  const meta = await getApiMeta(db);
  const prog = await getSyncProgress(db);
  const cron = await getCronHeartbeat(db);
  const chunkLocked = await isChunkLocked(db);
  const activity_log = await getActivityLog(db);
  const apiTotal = prog.apiTotal ?? meta.totalSekolah ?? ESTIMATED_TOTAL_RECORDS;
  const row_fp = await getRowFpStatsForReport(db, meta.totalSekolah ?? apiTotal);
  const currentOffset = prog.currentOffset ?? 0;
  let resolved = resolveSyncRunState(prog, apiTotal, cron, { chunkLocked });
  if (resolved.stale && prog.runState === 'running') {
    await markSyncStalled(db);
  }
  const runState = resolved.runState;
  const pct = progressPercent(currentOffset);
  const remaining = Math.max(0, apiTotal - currentOffset);

  const pausedManual = runState === 'stalled' && !cron.enabled && currentOffset < apiTotal;

  let statusLabel = 'Siap';
  if (pausedManual) statusLabel = 'Dijeda (cron nonaktif)';
  else if (runState === 'running') statusLabel = 'Sedang berjalan';
  else if (runState === 'completed') statusLabel = 'Selesai';
  else if (runState === 'stalled') {
    statusLabel = resolved.staleMinutes
      ? `Terhenti (~${resolved.staleMinutes} menit tanpa aktivitas)`
      : 'Terhenti';
  }

  return {
    status: 'success',
    sinkronisasi: {
      run_state: runState,
      status_label: statusLabel,
      current_offset: currentOffset,
      api_total: apiTotal,
      progress_percent: pct,
      records_processed: currentOffset,
      records_remaining: remaining,
      progress_label: `${currentOffset.toLocaleString('id-ID')} / ${apiTotal.toLocaleString('id-ID')} sekolah`,
      last_chunk_at: prog.lastChunkAt,
      last_chunk_at_wib: prog.lastChunkAt ? formatSyncTimeWib(prog.lastChunkAt) : null,
      is_stale: resolved.stale,
      lanjutkan_dari_offset: runState === 'stalled' ? currentOffset : null,
      catatan:
        pausedManual
          ? `Sync dijeda manual. Lanjutkan besok: GET /run?offset=${currentOffset}&resume=1&secret=... (mode cepat). Jangan /run?offset=0 tanpa resume.`
          : runState === 'stalled'
          ? 'Cron /tick tiap menit akan melanjutkan otomatis dari offset terakhir (status kembali running). Opsional: GET /run?offset=...&secret=...'
          : runState === 'running'
            ? cron.enabled
              ? 'Sync mingguan mode cepat: burst ~18×600/hal per menit (3×200/hal) bila fp_skip tinggi. Halaman sama dengan API = tanpa baca D1.'
              : 'Panggil /run sekali (atau tunggu jadwal mingguan) untuk mengaktifkan /tick otomatis.'
            : null,
    },
    database: {
      total_sekolah: meta.totalSekolah,
      waktu_update_terakhir: meta.lastSyncIso ? formatSyncTimeWib(meta.lastSyncIso) : null,
      waktu_update_terakhir_iso: meta.lastSyncIso,
    },
    jadwal:
      'Cloudflare Cron · /tick * * * * * (tiap menit) · /run 0 17 * * SUN (= Senin 01:00 WITA, UTC)',
    cron_job: {
      enabled: cron.enabled,
      last_call_at: cron.lastTick,
      last_call_wib: cron.lastTick ? formatSyncTimeWib(cron.lastTick) : null,
      last_call_note: cron.lastNote,
    },
    /** @deprecated gunakan cron_job */
    cron: {
      enabled: cron.enabled,
      last_tick_at: cron.lastTick,
      last_tick_wib: cron.lastTick ? formatSyncTimeWib(cron.lastTick) : null,
      last_tick_note: cron.lastNote,
    },
    endpoints: {
      status: '/',
      status_json: '/?format=json',
    },
    cloudflare_cron: {
      tick: { cron: '* * * * *', keterangan: 'Lanjutkan sync saat status running' },
      run: { cron: '0 17 * * SUN', keterangan: 'Sync penuh — Senin 01:00 WITA' },
    },
    http_manual: {
      tick: 'GET WORKER_BASE/tick',
      run: 'GET WORKER_BASE/run?offset=0',
      header: 'X-Sync-Secret: <SYNC_SECRET>',
    },
    catatan_keamanan:
      'Memulai sinkron manual (/run) memerlukan SYNC_SECRET. Dashboard ini hanya menampilkan status.',
    row_fp,
    row_fp_halaman: PAGES_BACKFILL_URL,
    activity_log,
    ...(lastChunk ? { chunk_terakhir: lastChunk } : {}),
  };
}

/**
 * @param {Array<object>} lines
 * @param {(v: unknown) => string} esc
 */
export function renderActivityLogItemsHtml(lines, esc) {
  if (!lines || !lines.length) {
    return '<li class="text-xs text-slate-400 leading-relaxed">Belum ada log. Setelah Cloudflare Cron atau panggilan /tick /run, entri muncul di sini (diterima → chunk data → offset naik).</li>';
  }
  return lines
    .map((line, i) => {
      const kind = line.kind || 'chunk';
      const badge = activityKindLabel(kind);
      const badgeClass =
        kind === 'cron_error'
          ? 'bg-red-100 text-red-800'
          : kind === 'backfill'
            ? 'bg-violet-100 text-violet-800'
          : kind === 'chunk'
            ? 'bg-blue-100 text-blue-800'
            : kind === 'cron_skip'
              ? 'bg-slate-100 text-slate-600'
              : 'bg-emerald-100 text-emerald-800';
      return `
          <li class="text-xs leading-relaxed border-l-2 pl-2.5 ${
            i === 0
              ? kind === 'backfill'
                ? 'border-violet-500 text-slate-800'
                : 'border-blue-500 text-slate-800'
              : 'border-slate-200 text-slate-600'
          }">
            <span class="flex flex-wrap items-center gap-1.5 mb-0.5">
              <span class="text-[10px] text-slate-400">${esc(line.wib)}</span>
              <span class="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${badgeClass}">${esc(badge)}</span>
            </span>
            <span class="font-mono text-[11px] leading-snug block">${esc(line.text)}</span>
          </li>`;
    })
    .join('');
}

function statusBadgeClass(runState) {
  if (runState === 'running') return 'bg-amber-100 text-amber-800';
  if (runState === 'stalled') return 'bg-red-100 text-red-800';
  if (runState === 'completed') return 'bg-green-100 text-green-800';
  return 'bg-slate-100 text-slate-600';
}

/**
 * @param {object} rf
 */
function rowFpStatusLabel(rf) {
  if (!rf?.measured) return 'Belum diukur';
  if (rf.selesai) return 'Lengkap';
  if (rf.backfill_stale) return 'Terhenti — cron lanjutkan';
  if (rf.backfill_cron && !rf.selesai) return 'Backfill (cron/menit)';
  if (rf.backfill_active) return 'Backfill berjalan';
  return 'Perlu dilengkapi';
}

/**
 * @param {object} rf
 */
function rowFpBadgeClass(rf) {
  if (!rf?.measured) return 'bg-slate-100 text-slate-600';
  if (rf.selesai) return 'bg-green-100 text-green-800';
  if (rf.backfill_active) return 'bg-amber-100 text-amber-800';
  return 'bg-violet-100 text-violet-800';
}

/**
 * @param {object} report
 */
export function renderSyncStatusHtml(report) {
  const s = report.sinkronisasi;
  const d = report.database;
  const esc = (v) =>
    String(v ?? '—')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const barPct = Math.min(100, s.progress_percent || 0);
  const homeUrl = 'https://api-sekolah-kita.pages.dev';
  const rf = report.row_fp || {};
  const rowFpPct = rf.percent_filled != null ? Math.min(100, rf.percent_filled) : 0;
  const backfillUrl = report.row_fp_halaman || PAGES_BACKFILL_URL;

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#059669">
  <title>Status Sinkronisasi — EduAPI Indonesia</title>
  <link rel="icon" href="/favicon-sync.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/favicon-sync.svg">
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-50 text-slate-800 font-sans antialiased min-h-screen p-4 sm:p-8">
  <div class="max-w-lg mx-auto">
    <header class="flex items-center justify-between gap-3 mb-6">
      <div class="flex items-center gap-2.5 min-w-0">
        <img src="/favicon-sync.svg" alt="" width="40" height="40" class="w-10 h-10 rounded-xl shadow-sm shrink-0">
        <div class="min-w-0">
          <h1 class="text-lg font-bold text-slate-900 truncate">Status sinkronisasi</h1>
          <p class="text-xs text-slate-500">EduAPI · Cloudflare Cron + D1</p>
        </div>
      </div>
      <a href="${homeUrl}" class="shrink-0 text-xs font-medium text-emerald-700 hover:text-emerald-900 bg-emerald-50 border border-emerald-200 px-2.5 py-1.5 rounded-lg">← Beranda</a>
    </header>
    <p id="refresh-hint" class="text-[11px] text-center text-slate-400 mb-4 -mt-2">Memperbarui sync, row_fp &amp; log otomatis · sinkron penuh pukul <span id="refresh-at">—</span></p>

    <div class="bg-white rounded-xl border border-slate-200 p-5 mb-4 shadow-sm">
      <div class="flex justify-between items-center mb-3">
        <span class="text-sm font-semibold text-slate-700">Progres sync</span>
        <span id="sync-status-badge" class="text-xs font-bold px-2.5 py-1 rounded-full ${statusBadgeClass(s.run_state)}">${esc(s.status_label)}</span>
      </div>
      <div class="h-2.5 bg-slate-100 rounded-full overflow-hidden mb-2">
        <div id="sync-progress-bar" class="h-full bg-blue-600 rounded-full transition-all duration-500" style="width:${barPct}%"></div>
      </div>
      <p id="sync-progress-pct" class="text-2xl font-bold text-slate-900">${esc(s.progress_percent)}%</p>
      <p id="sync-progress-label" class="text-sm text-slate-600 mt-1">${esc(s.progress_label)}</p>
      <p id="sync-progress-offset" class="text-xs text-slate-400 mt-2">Offset saat ini: ${esc(s.current_offset)} · Sisa ~${esc(s.records_remaining.toLocaleString('id-ID'))}</p>
    </div>

    <div class="bg-white rounded-xl border border-slate-200 p-5 mb-4 shadow-sm text-sm space-y-2">
      <p><span class="text-slate-500">Total di database</span><br><strong id="sync-details-total">${d.total_sekolah != null ? esc(d.total_sekolah.toLocaleString('id-ID')) + ' sekolah' : '—'}</strong></p>
      <p><span class="text-slate-500">Update data terakhir</span><br><strong id="sync-details-update">${esc(d.waktu_update_terakhir)}</strong></p>
      <p><span class="text-slate-500">Chunk terakhir diproses</span><br><strong id="sync-details-chunk">${esc(s.last_chunk_at_wib)}</strong></p>
      <p><span class="text-slate-500">Cron terakhir</span><br><strong id="sync-cron-last">${esc(report.cron_job?.last_call_wib ?? report.cron?.last_tick_wib)}</strong><br><span id="sync-cron-note" class="text-xs text-slate-400">${esc(report.cron_job?.last_call_note ?? report.cron?.last_tick_note)}</span></p>
      <p><span class="text-slate-500">Job /tick aktif</span><br><strong id="sync-cron-active">${(report.cron_job?.enabled ?? report.cron?.enabled) ? 'Ya (sync berjalan)' : 'Tidak (idle / selesai)'}</strong></p>
      <p><span class="text-slate-500">Jadwal</span><br>${esc(report.jadwal)}</p>
      <p id="sync-catatan" class="text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-3 text-xs leading-relaxed${s.catatan ? '' : ' hidden'}">${esc(s.catatan || '')}</p>
    </div>

    <div class="bg-white rounded-xl border border-violet-200 p-5 mb-4 shadow-sm">
      <div class="flex justify-between items-start gap-2 mb-3">
        <div>
          <span class="text-sm font-semibold text-slate-700">Kolom <code class="text-xs bg-violet-50 px-1 rounded">row_fp</code></span>
          <p class="text-[11px] text-slate-500 mt-0.5">Sidik jari baris · hemat kuota sync</p>
        </div>
        <span id="row-fp-badge" class="text-xs font-bold px-2.5 py-1 rounded-full shrink-0 ${rowFpBadgeClass(rf)}">${esc(rowFpStatusLabel(rf))}</span>
      </div>
      <div class="h-2.5 bg-slate-100 rounded-full overflow-hidden mb-2">
        <div id="row-fp-progress-bar" class="h-full bg-violet-600 rounded-full transition-all duration-500" style="width:${rowFpPct}%"></div>
      </div>
      <p id="row-fp-percent" class="text-xl font-bold text-slate-900">${rf.percent_filled != null ? esc(rf.percent_filled) + '% terisi' : '—'}</p>
      <p id="row-fp-counts" class="text-sm text-slate-600 mt-1">${rf.measured ? `Kosong: ${Number(rf.null_count).toLocaleString('id-ID')} · Terisi: ${Number(rf.filled_count).toLocaleString('id-ID')}${rf.total ? ' / ' + Number(rf.total).toLocaleString('id-ID') : ''}` : 'Klik tombol di bawah untuk mengukur sisa NULL (butuh secret).'}</p>
      <p id="row-fp-stats-at" class="text-xs text-slate-400 mt-2">Terakhir diukur: ${esc(rf.stats_at_wib || 'belum pernah')}</p>
      <p id="row-fp-note" class="text-xs text-violet-700 mt-1${rf.backfill_note ? '' : ' hidden'}">${esc(rf.backfill_note || '')}</p>
      <a id="row-fp-cta" href="${esc(backfillUrl)}" class="mt-4 inline-flex w-full items-center justify-center gap-2 bg-violet-600 text-white text-sm font-semibold px-4 py-2.5 rounded-lg hover:bg-violet-700 transition-colors shadow-sm">
        <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
        Cek &amp; backfill row_fp
      </a>
    </div>

    <div class="bg-white rounded-xl border border-slate-200 p-5 mb-4 shadow-sm">
      <div class="flex justify-between items-center mb-3">
        <span class="text-sm font-semibold text-slate-700">Log aktivitas (Cron)</span>
        <span id="activity-log-hint" class="text-[10px] text-slate-400">8 terbaru · pembaruan otomatis</span>
      </div>
      <ol id="activity-log-list" class="space-y-2.5 list-none m-0 p-0">
        ${renderActivityLogItemsHtml(report.activity_log, esc)}
      </ol>
    </div>

    <p class="text-xs text-slate-500 bg-slate-100 border border-slate-200 rounded-lg px-3 py-2 mb-4 text-center leading-relaxed">
      Hanya pemilik API yang dapat memulai sinkron (endpoint <code class="bg-white px-1 rounded">/run</code> dilindungi <code class="bg-white px-1 rounded">SYNC_SECRET</code>).
    </p>

    <p class="text-xs text-slate-400 text-center">JSON: <a class="text-blue-600 underline" href="?format=json">?format=json</a> · Progres &amp; log diperbarui otomatis tanpa reload halaman</p>
  </div>
  <script>
    (function () {
      var POLL_MS = 4000;
      var atEl = document.getElementById('refresh-at');
      var logHint = document.getElementById('activity-log-hint');
      var lastSnapshot = '';
      var pollTimer = null;

      function msUntilNextMinute() {
        var n = new Date();
        return (60 - n.getSeconds()) * 1000 - n.getMilliseconds();
      }

      function nextMinuteTime() {
        return new Date(Date.now() + msUntilNextMinute());
      }

      function formatClock(d) {
        return d.toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
      }

      function escHtml(v) {
        return String(v ?? '—')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }

      function statusBadgeClass(runState) {
        var base = 'text-xs font-bold px-2.5 py-1 rounded-full ';
        if (runState === 'running') return base + 'bg-amber-100 text-amber-800';
        if (runState === 'stalled') return base + 'bg-red-100 text-red-800';
        if (runState === 'completed') return base + 'bg-green-100 text-green-800';
        return base + 'bg-slate-100 text-slate-600';
      }

      function activityKindLabel(kind) {
        if (kind === 'chunk') return 'Chunk data';
        if (kind === 'backfill') return 'Backfill row_fp';
        if (kind === 'cron_tick') return 'Cron /tick';
        if (kind === 'cron_skip') return 'Cron /tick';
        if (kind === 'cron_run') return 'Cron /run';
        if (kind === 'cron_error') return 'Error';
        return 'Aktivitas';
      }

      function renderActivityLog(lines) {
        if (!lines || !lines.length) {
          return '<li class="text-xs text-slate-400 leading-relaxed">Belum ada log. Setelah Cloudflare Cron atau panggilan /tick /run, entri muncul di sini (diterima → chunk data → offset naik).</li>';
        }
        return lines
          .map(function (line, i) {
            var kind = line.kind || 'chunk';
            var badge = activityKindLabel(kind);
            var badgeClass =
              kind === 'cron_error'
                ? 'bg-red-100 text-red-800'
                : kind === 'backfill'
                  ? 'bg-violet-100 text-violet-800'
                : kind === 'chunk'
                  ? 'bg-blue-100 text-blue-800'
                  : kind === 'cron_skip'
                    ? 'bg-slate-100 text-slate-600'
                    : 'bg-emerald-100 text-emerald-800';
            return (
              '<li class="text-xs leading-relaxed border-l-2 pl-2.5 ' +
              (i === 0
                ? kind === 'backfill'
                  ? 'border-violet-500 text-slate-800'
                  : 'border-blue-500 text-slate-800'
                : 'border-slate-200 text-slate-600') +
              '"><span class="flex flex-wrap items-center gap-1.5 mb-0.5"><span class="text-[10px] text-slate-400">' +
              escHtml(line.wib) +
              '</span><span class="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ' +
              badgeClass +
              '">' +
              escHtml(badge) +
              '</span></span><span class="font-mono text-[11px] leading-snug block">' +
              escHtml(line.text) +
              '</span></li>'
            );
          })
          .join('');
      }

      function rowFpStatusLabel(rf) {
        if (!rf || !rf.measured) return 'Belum diukur';
        if (rf.selesai) return 'Lengkap';
        if (rf.backfill_stale) return 'Terhenti — cron lanjutkan';
        if (rf.backfill_cron && !rf.selesai) return 'Backfill (cron/menit)';
        if (rf.backfill_active) return 'Backfill berjalan';
        return 'Perlu dilengkapi';
      }

      function rowFpBadgeClass(rf) {
        var base = 'text-xs font-bold px-2.5 py-1 rounded-full shrink-0 ';
        if (!rf || !rf.measured) return base + 'bg-slate-100 text-slate-600';
        if (rf.selesai) return base + 'bg-green-100 text-green-800';
        if (rf.backfill_cron) return base + 'bg-amber-100 text-amber-800';
        if (rf.backfill_active) return base + 'bg-amber-100 text-amber-800';
        return base + 'bg-violet-100 text-violet-800';
      }

      function applyRowFp(rf) {
        if (!rf) return;
        var pct = rf.percent_filled != null ? Math.min(100, rf.percent_filled) : 0;
        var badge = document.getElementById('row-fp-badge');
        if (badge) {
          badge.className = rowFpBadgeClass(rf);
          badge.textContent = rowFpStatusLabel(rf);
        }
        var bar = document.getElementById('row-fp-progress-bar');
        if (bar) bar.style.width = pct + '%';
        var pctEl = document.getElementById('row-fp-percent');
        if (pctEl) {
          pctEl.textContent =
            rf.percent_filled != null ? rf.percent_filled + '% terisi' : '—';
        }
        var counts = document.getElementById('row-fp-counts');
        if (counts) {
          counts.textContent = rf.measured
            ? 'Kosong: ' +
              Number(rf.null_count).toLocaleString('id-ID') +
              ' · Terisi: ' +
              Number(rf.filled_count).toLocaleString('id-ID') +
              (rf.total ? ' / ' + Number(rf.total).toLocaleString('id-ID') : '')
            : 'Klik tombol di bawah untuk mengukur sisa NULL (butuh secret).';
        }
        var at = document.getElementById('row-fp-stats-at');
        if (at) at.textContent = 'Terakhir diukur: ' + (rf.stats_at_wib || 'belum pernah');
        var noteEl = document.getElementById('row-fp-note');
        if (noteEl) {
          if (rf.backfill_note) {
            noteEl.textContent = rf.backfill_note;
            noteEl.classList.remove('hidden');
          } else {
            noteEl.classList.add('hidden');
          }
        }
        var cta = document.getElementById('row-fp-cta');
        if (cta && rf.halaman_backfill) cta.href = rf.halaman_backfill;
      }

      function reportSnapshot(r) {
        var s = r.sinkronisasi || {};
        var cj = r.cron_job || r.cron || {};
        var rf = r.row_fp || {};
        return [
          s.run_state,
          s.current_offset,
          s.progress_percent,
          s.last_chunk_at,
          r.database && r.database.waktu_update_terakhir_iso,
          cj.last_call_at,
          cj.last_call_note,
          rf.null_count,
          rf.percent_filled,
          rf.backfill_active,
          rf.backfill_cron,
          rf.backfill_stale,
          rf.backfill_note,
          rf.stats_at,
          JSON.stringify(r.activity_log || []),
        ].join('|');
      }

      function applyReport(r) {
        var s = r.sinkronisasi || {};
        var d = r.database || {};
        var cj = r.cron_job || r.cron || {};
        var pct = Math.min(100, s.progress_percent || 0);

        var badge = document.getElementById('sync-status-badge');
        if (badge) {
          badge.className = statusBadgeClass(s.run_state);
          badge.textContent = s.status_label || '—';
        }

        var bar = document.getElementById('sync-progress-bar');
        if (bar) bar.style.width = pct + '%';

        var pctEl = document.getElementById('sync-progress-pct');
        if (pctEl) pctEl.textContent = (s.progress_percent != null ? s.progress_percent : '—') + '%';

        var labelEl = document.getElementById('sync-progress-label');
        if (labelEl) labelEl.textContent = s.progress_label || '—';

        var offsetEl = document.getElementById('sync-progress-offset');
        if (offsetEl) {
          var remaining = s.records_remaining != null ? s.records_remaining : 0;
          offsetEl.textContent =
            'Offset saat ini: ' +
            (s.current_offset != null ? s.current_offset : '—') +
            ' · Sisa ~' +
            Number(remaining).toLocaleString('id-ID');
        }

        var totalEl = document.getElementById('sync-details-total');
        if (totalEl) {
          totalEl.textContent =
            d.total_sekolah != null
              ? Number(d.total_sekolah).toLocaleString('id-ID') + ' sekolah'
              : '—';
        }

        var updateEl = document.getElementById('sync-details-update');
        if (updateEl) updateEl.textContent = d.waktu_update_terakhir || '—';

        var chunkEl = document.getElementById('sync-details-chunk');
        if (chunkEl) chunkEl.textContent = s.last_chunk_at_wib || '—';

        var cronLast = document.getElementById('sync-cron-last');
        if (cronLast) cronLast.textContent = cj.last_call_wib || cj.last_tick_wib || '—';

        var cronNote = document.getElementById('sync-cron-note');
        if (cronNote) cronNote.textContent = cj.last_call_note || cj.last_tick_note || '';

        var cronActive = document.getElementById('sync-cron-active');
        if (cronActive) {
          cronActive.textContent = cj.enabled ? 'Ya (sync berjalan)' : 'Tidak (idle / selesai)';
        }

        var catatan = document.getElementById('sync-catatan');
        if (catatan) {
          if (s.catatan) {
            catatan.textContent = s.catatan;
            catatan.classList.remove('hidden');
          } else {
            catatan.classList.add('hidden');
          }
        }

        var list = document.getElementById('activity-log-list');
        if (list) list.innerHTML = renderActivityLog(r.activity_log);

        applyRowFp(r.row_fp);
      }

      function fetchStatus() {
        var url = location.pathname + (location.search || '');
        var sep = url.indexOf('?') >= 0 ? '&' : '?';
        return fetch(url + sep + 'format=json', { cache: 'no-store' })
          .then(function (res) {
            return res.json();
          })
          .then(function (report) {
            if (report.status !== 'success') return;
            var snap = reportSnapshot(report);
            if (snap !== lastSnapshot) {
              lastSnapshot = snap;
              applyReport(report);
            }
            if (logHint) {
              logHint.textContent =
                '8 terbaru · terakhir diperbarui pukul ' + formatClock(new Date());
            }
          })
          .catch(function () { /* abaikan, coba lagi */ });
      }

      function updateMinuteHint() {
        if (atEl) atEl.textContent = formatClock(nextMinuteTime());
      }

      function startPolling() {
        if (pollTimer) clearInterval(pollTimer);
        fetchStatus();
        pollTimer = setInterval(fetchStatus, POLL_MS);
      }

      function stopPolling() {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      }

      updateMinuteHint();
      setInterval(updateMinuteHint, 1000);
      startPolling();

      document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
          stopPolling();
        } else {
          startPolling();
        }
      });
    })();
  </script>
</body>
</html>`;
}
