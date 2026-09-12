/**
 * Skrip Manajemen & Pembersihan Workflow Runs GitHub Actions
 * 
 * Fitur:
 * 1. Mencegah antrean menumpuk (concurrency guard):
 *    - Mendeteksi apakah sudah ada proses sinkronisasi yang sedang berjalan (in_progress).
 *    - Jika ada yang berjalan, otomatis batalkan semua antrean (queued) dan batalkan run saat ini agar tidak menumpuk.
 * 2. Pembersihan riwayat run otomatis (prune history):
 *    - Mempertahankan setidaknya 4 workflow run terbaru untuk setiap workflow.
 *    - Menghapus semua run lama yang sudah selesai/dibatalkan sehingga riwayat tidak membengkak (misal 152 runs).
 */

const fs = require('fs');

const repoFull = process.env.GITHUB_REPOSITORY || 'bahrye/api-sekolah';
const [repoOwner, repoName] = repoFull.split('/');
const OWNER = process.env.GITHUB_REPOSITORY_OWNER || repoOwner || 'bahrye';
const REPO = repoName || 'api-sekolah';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const CURRENT_RUN_ID = process.env.GITHUB_RUN_ID ? String(process.env.GITHUB_RUN_ID) : null;
const KEEP_COUNT = Math.max(1, parseInt(process.env.KEEP_RUNS_COUNT || '4', 10));
const CLEANUP_SCOPE = (process.env.CLEANUP_SCOPE || 'global').toLowerCase();

async function githubFetch(endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `https://api.github.com/repos/${OWNER}/${REPO}${endpoint}`;
  const headers = {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'api-sekolah-github-actions-manager',
    ...(options.headers || {}),
  };
  return await fetch(url, { ...options, headers });
}

async function getAllRuns() {
  let allRuns = [];
  let page = 1;
  const maxPages = 15; // Hingga 1.500 runs
  
  while (page <= maxPages) {
    try {
      const res = await githubFetch(`/actions/runs?per_page=100&page=${page}`);
      if (!res.ok) {
        console.warn(`Gagal mengambil halaman ${page}: HTTP ${res.status}`);
        break;
      }
      const json = await res.json();
      const runs = json.workflow_runs || [];
      if (runs.length === 0) break;
      allRuns.push(...runs);
      if (runs.length < 100) break;
      page++;
    } catch (err) {
      console.warn(`Error fetching runs page ${page}:`, err.message);
      break;
    }
  }
  return allRuns;
}

function setGithubOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    try {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    } catch (e) {
      console.warn('Gagal menulis GITHUB_OUTPUT:', e.message);
    }
  }
}

async function cancelQueuedAndSelfIfBusy() {
  if (!TOKEN) {
    console.log('⚠️ GITHUB_TOKEN tidak tersedia, melewati pengecekan antrean.');
    setGithubOutput('skip_sync', 'false');
    return { shouldContinue: true };
  }

  console.log(`🔍 Memeriksa status antrean workflow run di ${OWNER}/${REPO}...`);
  const allRuns = await getAllRuns();
  console.log(`📊 Ditemukan total ${allRuns.length} workflow runs di GitHub Actions.`);

  // Ambil info workflow saat ini jika CURRENT_RUN_ID ada
  let currentRun = null;
  if (CURRENT_RUN_ID) {
    currentRun = allRuns.find(r => String(r.id) === CURRENT_RUN_ID);
  }
  const currentWorkflowName = currentRun ? currentRun.name : 'Sinkronisasi Data Sekolah Otomatis (15 Menit)';

  // 1. Cek run yang sedang berjalan (in_progress) untuk workflow yang sama atau sejenis
  const inProgressRuns = allRuns.filter(r => {
    if (r.status !== 'in_progress') return false;
    if (CURRENT_RUN_ID && String(r.id) === CURRENT_RUN_ID) return false;
    
    // Cek apakah nama workflow relevan (sinkronisasi)
    const isSyncWf = (r.name || '').toLowerCase().includes('sinkronisasi') || (r.name === currentWorkflowName);
    return isSyncWf;
  });

  if (inProgressRuns.length > 0) {
    const runningRun = inProgressRuns[0];
    console.log(`\n🛑 PERHATIAN: Ada proses sinkronisasi yang SEDANG BERJALAN!`);
    console.log(`   Run ID: #${runningRun.id} (${runningRun.name})`);
    console.log(`   Dimulai: ${runningRun.run_started_at || runningRun.created_at}`);
    console.log(`\n🚫 Menghindari tabrakan proses & penumpukan antrean:`);

    // Batalkan semua queued runs dari workflow ini agar tidak antre menunggu
    const queuedRuns = allRuns.filter(r => r.status === 'queued' && String(r.id) !== CURRENT_RUN_ID);
    for (const q of queuedRuns) {
      console.log(`  🗑️ Membatalkan antrean Run #${q.id} (${q.name})...`);
      try {
        await githubFetch(`/actions/runs/${q.id}/cancel`, { method: 'POST' });
      } catch (e) {}
    }

    // Batalkan run saat ini di GitHub Actions
    if (CURRENT_RUN_ID) {
      console.log(`  🛑 Membatalkan run saat ini (Run #${CURRENT_RUN_ID})...`);
      try {
        await githubFetch(`/actions/runs/${CURRENT_RUN_ID}/cancel`, { method: 'POST' });
      } catch (e) {}
    }

    setGithubOutput('skip_sync', 'true');
    return { shouldContinue: false };
  }

  // 2. Jika tidak ada yang in_progress selain ini, bersihkan sisa-sisa queued runs lama
  const queuedRuns = allRuns.filter(r => r.status === 'queued' && String(r.id) !== CURRENT_RUN_ID);
  if (queuedRuns.length > 0) {
    console.log(`🧹 Membersihkan ${queuedRuns.length} antrean lama yang menumpuk...`);
    for (const q of queuedRuns) {
      console.log(`  🗑️ Membatalkan antrean lama Run #${q.id} (${q.name})...`);
      try {
        await githubFetch(`/actions/runs/${q.id}/cancel`, { method: 'POST' });
      } catch (e) {}
    }
  }

  setGithubOutput('skip_sync', 'false');
  console.log('✅ Antrean bersih, proses sinkronisasi aman untuk dilanjutkan.');
  return { shouldContinue: true };
}

async function cleanupOldHistory() {
  if (!TOKEN) {
    console.log('⚠️ GITHUB_TOKEN tidak tersedia, melewati pembersihan riwayat run.');
    return;
  }

  const isGlobal = CLEANUP_SCOPE === 'global';
  console.log(`\n🧹 Memeriksa riwayat workflow run lama untuk dibersihkan...`);
  console.log(`   Mode Cakupan : ${isGlobal ? '🌐 GLOBAL (seluruh repositori)' : '📁 PER WORKFLOW'}`);
  console.log(`   Target Simpan: ${KEEP_COUNT} run selesai terbaru`);

  const allRuns = await getAllRuns();

  // Catat run yang sedang berlangsung / antre (TIDAK AKAN DIHAPUS)
  const activeRuns = allRuns.filter(r => r.status === 'in_progress' || r.status === 'queued');
  if (activeRuns.length > 0) {
    console.log(`\n⚡ Ditemukan ${activeRuns.length} proses yang SEDANG BERJALAN / ANTRE (AMAN, tidak akan dihapus):`);
    activeRuns.forEach(a => console.log(`   - [${a.name}] Run #${a.id} (${a.status})`));
  }

  // Ambil hanya run yang sudah selesai (completed, cancelled, failure, dll) selain run pembersihan saat ini
  const finishedRuns = allRuns.filter(r => r.status === 'completed' && String(r.id) !== CURRENT_RUN_ID);

  if (finishedRuns.length === 0) {
    console.log('\n✨ Belum ada riwayat run yang selesai untuk dibersihkan.');
    return;
  }

  let allRunsToDelete = [];

  if (isGlobal) {
    // Mode GLOBAL: urutkan seluruh run yang sudah selesai secara global dari terbaru ke terlama
    finishedRuns.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    
    const toKeep = finishedRuns.slice(0, KEEP_COUNT);
    const toDelete = finishedRuns.slice(KEEP_COUNT);

    console.log(`\n📋 Ringkasan Pembersihan Global:`);
    console.log(`   Total selesai di repo : ${finishedRuns.length}`);
    console.log(`   Dipertahankan         : ${toKeep.length}`);
    console.log(`   Akan dihapus          : ${toDelete.length}`);

    if (toKeep.length > 0) {
      console.log(`   Daftar run yang dipertahankan:`);
      toKeep.forEach(k => console.log(`     - [${k.name}] Run #${k.id} [${k.conclusion || k.status}] (${k.created_at})`));
    }

    allRunsToDelete.push(...toDelete);
  } else {
    // Mode PER WORKFLOW: kelompokkan per nama workflow
    const runsByWorkflow = {};
    for (const r of finishedRuns) {
      const wfName = r.name || 'Workflow Lain';
      if (!runsByWorkflow[wfName]) runsByWorkflow[wfName] = [];
      runsByWorkflow[wfName].push(r);
    }

    for (const [wfName, runs] of Object.entries(runsByWorkflow)) {
      runs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      
      const toKeep = runs.slice(0, KEEP_COUNT);
      const toDelete = runs.slice(KEEP_COUNT);

      console.log(`\n📋 Workflow: "${wfName}"`);
      console.log(`   Total selesai: ${runs.length} | Dipertahankan: ${toKeep.length} | Akan dihapus: ${toDelete.length}`);
      if (toKeep.length > 0) {
        console.log(`   Daftar yang dipertahankan:`);
        toKeep.forEach(k => console.log(`     - Run #${k.id} [${k.conclusion || k.status}] (${k.created_at})`));
      }

      allRunsToDelete.push(...toDelete);
    }
  }

  if (allRunsToDelete.length === 0) {
    console.log(`\n✨ Riwayat workflow sudah bersih (target <= ${KEEP_COUNT} riwayat).`);
    return;
  }

  console.log(`\n🗑️ Memulai penghapusan ${allRunsToDelete.length} workflow runs lama...`);
  let deletedCount = 0;
  for (let i = 0; i < allRunsToDelete.length; i++) {
    const r = allRunsToDelete[i];
    try {
      const delRes = await githubFetch(`/actions/runs/${r.id}`, { method: 'DELETE' });
      if (delRes.ok || delRes.status === 204) {
        deletedCount++;
        process.stdout.write(`\r  [${deletedCount}/${allRunsToDelete.length}] Berhasil menghapus Run #${r.id}`);
      } else {
        console.warn(`\n  ⚠️ Gagal menghapus Run #${r.id}: HTTP ${delRes.status}`);
      }
    } catch (err) {
      console.warn(`\n  ⚠️ Gagal menghapus Run #${r.id}: ${err.message}`);
    }

    // Delay kecil 50ms untuk menghindari rate limit API GitHub
    await new Promise(res => setTimeout(res, 50));
  }

  console.log(`\n🎉 Selesai! Sebanyak ${deletedCount} riwayat workflow lama berhasil dibersihkan.`);
}

async function cancelActiveQueuedRunsOnly() {
  if (!TOKEN) return;
  try {
    const res = await githubFetch('/actions/runs?status=queued');
    if (!res.ok) return;
    const data = await res.json();
    const queuedRuns = (data.workflow_runs || []).filter(r => String(r.id) !== CURRENT_RUN_ID);
    if (queuedRuns.length > 0) {
      console.log(`🧹 Membatalkan ${queuedRuns.length} antrean queued baru yang menumpuk...`);
      for (const q of queuedRuns) {
        await githubFetch(`/actions/runs/${q.id}/cancel`, { method: 'POST' });
        console.log(`  🗑️ Antrean Run #${q.id} dibatalkan.`);
      }
    }
  } catch (e) {}
}

async function main() {
  const mode = process.argv[2] || 'all';

  if (mode === 'check-running') {
    const { shouldContinue } = await cancelQueuedAndSelfIfBusy();
    if (!shouldContinue) {
      process.exit(0); // Exit 0 dengan skip_sync=true agar tidak memicu status fail merah di GitHub
    }
  } else if (mode === 'cleanup-history') {
    await cleanupOldHistory();
  } else if (mode === 'cancel-queued') {
    await cancelActiveQueuedRunsOnly();
  } else {
    // Mode all: jalankan check lalu cleanup
    const { shouldContinue } = await cancelQueuedAndSelfIfBusy();
    await cleanupOldHistory();
  }
}

main().catch(err => {
  console.error('Error pada clean-github-runs:', err);
  process.exit(0); // Jangan gagalkan workflow hanya karena pembersihan gagal
});
