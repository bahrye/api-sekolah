/**
 * Migrasi data sekolah dari API publik (D1) ke Neon PostgreSQL.
 *
 * Usage (PowerShell):
 *   $env:NEON_DATABASE_URL = "postgresql://..."
 *   $env:API_BASE = "https://api-sekolah-kita.pages.dev"   # opsional
 *   node scripts/migrate-to-neon.js
 *
 * Lanjut dari offset tertentu:
 *   $env:START_OFFSET = "50000"
 *   node scripts/migrate-to-neon.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const API_BASE = (process.env.API_BASE || 'https://api-sekolah-kita.pages.dev').replace(/\/$/, '');
const PAGE_LIMIT = Math.min(250, Math.max(1, parseInt(process.env.PAGE_LIMIT || '250', 10) || 250));
const START_OFFSET = Math.max(0, parseInt(process.env.START_OFFSET || '0', 10) || 0);
const DELAY_MS = Math.max(0, parseInt(process.env.FETCH_DELAY_MS || '150', 10) || 150);
const NEON_URL = process.env.NEON_DATABASE_URL;

const COLUMNS = [
  'npsn',
  'nama',
  'bentuk_pendidikan',
  'bentuk_pendidikan_group',
  'jenis_pendidikan',
  'status_satuan_pendidikan',
  'jenjang_pendidikan',
  'pembina',
  'jalur_pendidikan',
  'nama_desa',
  'nama_kecamatan',
  'nama_kabupaten',
  'nama_provinsi',
  'alamat_jalan',
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadEnvMigrateLocal() {
  const p = path.join(ROOT, '.env.migrate.local');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

async function fetchPage(offset) {
  const url = `${API_BASE}/api/sekolah?limit=${PAGE_LIMIT}&offset=${offset}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'MigrateToNeon/1.0' },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} @ offset ${offset}: ${text.slice(0, 200)}`);
  }
  const json = JSON.parse(text);
  if (json.status !== 'success') {
    throw new Error(json.message || `API error @ offset ${offset}`);
  }
  const limitUsed = json.metadata?.limit_ditampilkan ?? PAGE_LIMIT;
  if (limitUsed < PAGE_LIMIT && offset === 0) {
    console.warn(
      `⚠ API hanya mengizinkan limit=${limitUsed} (bukan ${PAGE_LIMIT}). Deploy Pages terbaru atau set PAGE_LIMIT=${limitUsed}.`
    );
  }
  return {
    rows: json.data || [],
    total: json.metadata?.total_data_tersedia,
    hasMore: json.metadata?.has_more === true,
    limitUsed,
  };
}

function rowToValues(row) {
  return COLUMNS.map((c) => {
    const v = row[c];
    if (v == null) return null;
    return String(v);
  });
}

async function insertBatch(client, rows) {
  if (!rows.length) return 0;
  const cols = COLUMNS.join(', ');
  const values = [];
  const params = [];
  let n = 1;
  for (const row of rows) {
    const tuple = rowToValues(row);
    values.push(`(${tuple.map(() => `$${n++}`).join(', ')})`);
    params.push(...tuple);
  }
  const sql = `
    INSERT INTO sekolah (${cols})
    VALUES ${values.join(', ')}
    ON CONFLICT (npsn) DO UPDATE SET
      nama = EXCLUDED.nama,
      bentuk_pendidikan = EXCLUDED.bentuk_pendidikan,
      bentuk_pendidikan_group = EXCLUDED.bentuk_pendidikan_group,
      jenis_pendidikan = EXCLUDED.jenis_pendidikan,
      status_satuan_pendidikan = EXCLUDED.status_satuan_pendidikan,
      jenjang_pendidikan = EXCLUDED.jenjang_pendidikan,
      pembina = EXCLUDED.pembina,
      jalur_pendidikan = EXCLUDED.jalur_pendidikan,
      nama_desa = EXCLUDED.nama_desa,
      nama_kecamatan = EXCLUDED.nama_kecamatan,
      nama_kabupaten = EXCLUDED.nama_kabupaten,
      nama_provinsi = EXCLUDED.nama_provinsi,
      alamat_jalan = EXCLUDED.alamat_jalan,
      migrated_at = NOW()
  `;
  await client.query(sql, params);
  return rows.length;
}

async function ensureSchema(client) {
  const sqlPath = path.join(ROOT, 'migrations', 'neon_sekolah.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  await client.query(sql);
}

async function getNeonCount(client) {
  const r = await client.query('SELECT COUNT(*)::int AS c FROM sekolah');
  return r.rows[0]?.c ?? 0;
}

async function main() {
  loadEnvMigrateLocal();
  const dbUrl = process.env.NEON_DATABASE_URL || NEON_URL;
  if (!dbUrl) {
    console.error('Set NEON_DATABASE_URL atau buat .env.migrate.local (lihat .env.migrate.local.example)');
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: true },
    max: 3,
  });

  const client = await pool.connect();
  try {
    await ensureSchema(client);
    const existing = await getNeonCount(client);
    console.log(`Neon: ${existing.toLocaleString('id-ID')} baris sudah ada`);

    let offset = START_OFFSET;
    let total = null;
    let inserted = 0;
    let pages = 0;
    const t0 = Date.now();

    while (true) {
      let page;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          page = await fetchPage(offset);
          break;
        } catch (err) {
          if (attempt === 5) throw err;
          console.warn(`Retry ${attempt}/5 offset ${offset}: ${err.message}`);
          await sleep(2000 * attempt);
        }
      }

      if (total == null && page.total != null) total = page.total;
      const batch = page.rows;
      const n = await insertBatch(client, batch);
      inserted += n;
      pages += 1;

      const pct =
        total != null ? ((offset + batch.length) / total * 100).toFixed(2) : '?';
      console.log(
        `[${new Date().toISOString()}] offset ${offset.toLocaleString('id-ID')} +${n} → total insert ${inserted.toLocaleString('id-ID')} (${pct}%)`
      );

      if (!batch.length) break;
      if (!page.hasMore && batch.length < (page.limitUsed || PAGE_LIMIT)) break;

      offset += batch.length;
      if (DELAY_MS) await sleep(DELAY_MS);
    }

    const finalCount = await getNeonCount(client);
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\nSelesai dalam ${sec}s — ${pages} halaman, ${finalCount.toLocaleString('id-ID')} baris di Neon.`);
    if (total != null && finalCount < total) {
      console.warn(`Perhatian: Neon ${finalCount} < sumber ${total}. Jalankan ulang atau cek START_OFFSET.`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
