/**
 * Menjalankan sync penuh dengan memanggil /api/sync per chunk (tanpa chain waitUntil).
 * Usage: node scripts/run-sync-until-done.js [startOffset]
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const BASE = process.env.API_BASE || 'https://api-sekolah-kita.pages.dev';
const MAX_PAGES_SAFE = 10;
const CHUNK_DELAY_MS = 1200;
const API_TOTAL = 552578;

/** @type {typeof import('../functions/lib/sync-chunk-ladder.js')} */
let ladder;

function readSecret() {
  const p = path.join(__dirname, '..', '.sync-secret.local');
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  if (process.env.SYNC_SECRET) return process.env.SYNC_SECRET;
  throw new Error('Secret tidak ditemukan (.sync-secret.local atau SYNC_SECRET)');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableStatus(status) {
  return status === 503 || status === 502 || status === 524 || status === 429;
}

function resolveStartPages() {
  const env = parseInt(process.env.SYNC_MAX_PAGES || '', 10);
  if (env && ladder.CHUNK_PAGES_LADDER.includes(env)) return env;
  if (env) return Math.min(ladder.CHUNK_PAGES_TOP, Math.max(1, env));
  return ladder.CHUNK_PAGES_FLOOR;
}

function stepDownPages(current) {
  return ladder.lowerChunkPages(current) ?? MAX_PAGES_SAFE;
}

async function runChunk(offset, secret, maxPages) {
  const url = `${BASE}/api/sync?secret=${encodeURIComponent(secret)}&offset=${offset}&maxPages=${maxPages}&no_chain=1`;
  const res = await fetch(url, { headers: { 'User-Agent': 'RunSyncUntilDone/1.0' } });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const err = new Error(
      res.status === 503
        ? `HTTP 503 — CPU Pages habis (coba maxPages≤10 atau pakai cron /tick). Respons: ${text.slice(0, 120)}`
        : `Respons bukan JSON (HTTP ${res.status})`
    );
    err.httpStatus = res.status;
    err.retryable = isRetryableStatus(res.status);
    throw err;
  }
  if (!res.ok && json.status !== 'in_progress' && json.status !== 'success') {
    const err = new Error(json.message || `HTTP ${res.status}`);
    err.httpStatus = res.status;
    err.retryable = isRetryableStatus(res.status) || json.retry_after_seconds != null;
    throw err;
  }
  if (isRetryableStatus(res.status)) {
    const err = new Error(json.message || `HTTP ${res.status}`);
    err.httpStatus = res.status;
    err.retryable = true;
    throw err;
  }
  return json;
}

async function main() {
  const ladderPath = path.join(__dirname, '../functions/lib/sync-chunk-ladder.js');
  ladder = await import(pathToFileURL(ladderPath).href);

  const secret = readSecret();
  let offset = Math.max(0, parseInt(process.argv[2] || '0', 10) || 0);
  const started = Date.now();
  let chunkNum = 0;
  let maxPages = resolveStartPages();

  const ladderLabel = ladder.CHUNK_RECORDS_LADDER.join('→');

  console.log(
    `Memulai sync dari offset=${offset} → ${BASE}\n` +
      `Tangga chunk: ${ladderLabel} sekolah (mulai ${maxPages} hal), fallback aman ${MAX_PAGES_SAFE} hal`
  );

  while (true) {
    chunkNum += 1;
    let json;
    let attempts = 0;
    let pagesThisChunk = maxPages;
    while (attempts < 5) {
      try {
        json = await runChunk(offset, secret, pagesThisChunk);
        break;
      } catch (err) {
        if (err.retryable && pagesThisChunk > MAX_PAGES_SAFE) {
          const next = stepDownPages(pagesThisChunk);
          console.log(
            `Turun ${pagesThisChunk} hal (~${pagesThisChunk * 20}) → ${next} hal (~${next * 20}) @ offset ${offset}`
          );
          pagesThisChunk = next;
          maxPages = next;
          attempts += 1;
          await sleep(3000);
          continue;
        }
        attempts += 1;
        const waitMs = err.retryable ? 8000 * attempts : 5000 * attempts;
        console.log(
          `Percobaan ${attempts}/5 gagal @ offset ${offset} (HTTP ${err.httpStatus || '?'}): ${err.message} — tunggu ${waitMs / 1000}s`
        );
        if (attempts >= 5) throw err;
        await sleep(waitMs);
      }
    }

    if (json.status === 'success') {
      const next = json.next_offset ?? offset;
      const apiTotal = json.api_total ?? API_TOTAL;
      if (next < apiTotal - 1) {
        console.warn(
          `Peringatan: status success tetapi next_offset ${next} < api_total ${apiTotal}. Melanjutkan...`
        );
        offset = next;
        await sleep(1000);
        continue;
      }
      const min = ((Date.now() - started) / 60000).toFixed(1);
      console.log(`\nSelesai dalam ~${min} menit, ${chunkNum} chunk.`);
      console.log(JSON.stringify(json.stats || json, null, 2));
      process.exit(0);
    }

    if (json.status !== 'in_progress') {
      throw new Error(`Status tidak dikenal: ${JSON.stringify(json)}`);
    }

    const c = json.chunk || {};
    const next = json.next_offset ?? offset + pagesThisChunk * 20;
    const pct = json.progress_percent ?? '?';

    console.log(
      `[${chunkNum}] offset ${offset}→${next} (${pct}%) | scan=${c.scanned} upd=${c.updated} ins=${c.inserted} skip=${c.skipped} fp_skip=${c.pages_fp_skip ?? 0} (${pagesThisChunk} hal/~${pagesThisChunk * 20})`
    );

    const needStepDown =
      json.timed_out || ladder.shouldStepDownChunk(c.scanned ?? 0, pagesThisChunk);
    if (needStepDown) {
      const lower = ladder.lowerChunkPages(pagesThisChunk);
      if (lower) {
        console.log(
          `Chunk ~${pagesThisChunk * 20} tidak muat — berikutnya ${lower} hal (~${lower * 20} sekolah)`
        );
        maxPages = lower;
      } else if (pagesThisChunk > MAX_PAGES_SAFE) {
        console.log(`Chunk ~${pagesThisChunk * 20} tidak muat — berikutnya ${MAX_PAGES_SAFE} hal (~200)`);
        maxPages = MAX_PAGES_SAFE;
      }
    } else if (
      !json.timed_out &&
      ladder.chunkMetTarget(c.scanned ?? 0, pagesThisChunk) &&
      pagesThisChunk >= ladder.CHUNK_PAGES_TOP
    ) {
      maxPages = ladder.CHUNK_PAGES_TOP;
    }

    if (next <= offset) {
      throw new Error('next_offset tidak maju — berhenti untuk menghindari loop.');
    }

    offset = next;
    const delay = json.timed_out ? CHUNK_DELAY_MS * 2 : CHUNK_DELAY_MS;
    await sleep(delay);
  }
}

main().catch((err) => {
  console.error('\nGagal:', err.message);
  console.error('Lanjutkan manual: node scripts/run-sync-until-done.js <offset_terakhir>');
  process.exit(1);
});
