/**
 * Isi tabel sync_page_fp dari API resmi tanpa membaca tabel sekolah.
 * Jalankan sekali setelah data awal ada di D1, sebelum sync bulanan penuh.
 *
 * Usage: node scripts/bootstrap-page-fp.js [startOffset]
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.API_BASE || 'https://api-sekolah-kita.pages.dev';
const CHUNK_DELAY_MS = 800;

function readSecret() {
  const p = path.join(__dirname, '..', '.sync-secret.local');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  if (process.env.SYNC_SECRET) return process.env.SYNC_SECRET;
  throw new Error('Secret tidak ditemukan (.sync-secret.local atau SYNC_SECRET)');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runChunk(offset, secret) {
  const url = `${BASE}/api/sync?secret=${encodeURIComponent(secret)}&offset=${offset}&maxPages=20&bootstrap_fp=1&no_chain=1`;
  const res = await fetch(url, { headers: { 'User-Agent': 'BootstrapPageFp/1.0' } });
  const json = await res.json();
  if (!res.ok && json.status !== 'in_progress' && json.status !== 'success') {
    throw new Error(json.message || `HTTP ${res.status}`);
  }
  return json;
}

async function main() {
  const secret = readSecret();
  let offset = Math.max(0, parseInt(process.argv[2] || '0', 10) || 0);
  let chunk = 0;

  console.log(`Bootstrap sync_page_fp dari offset ${offset} → ${BASE}`);

  for (;;) {
    chunk += 1;
    const json = await runChunk(offset, secret);
    const next = json.next_offset ?? offset;
    const pct = json.progress_percent ?? 0;
    const saved = json.chunk?.pages_fp_saved ?? 0;
    console.log(
      `[${chunk}] offset ${offset}→${next} (${pct}%) · hal disimpan=${saved}`
    );

    if (json.status === 'success' || json.done) {
      console.log('Bootstrap selesai.');
      break;
    }

    offset = next;
    await sleep(CHUNK_DELAY_MS);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
