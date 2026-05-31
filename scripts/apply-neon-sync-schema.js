import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env.migrate.local');
if (!fs.existsSync(envFile)) {
  console.error('Buat .env.migrate.local dengan NEON_DATABASE_URL');
  process.exit(1);
}
const url = fs
  .readFileSync(envFile, 'utf8')
  .match(/NEON_DATABASE_URL=(.+)/)?.[1]
  ?.trim();
if (!url) process.exit(1);

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: true } });
for (const file of ['neon_sync_tables.sql', 'status_sinkronisasi.sql']) {
  const sql = fs.readFileSync(path.join(root, 'migrations', file), 'utf8');
  await pool.query(sql);
  console.log('OK —', file);
}
const c = await pool.query('SELECT COUNT(*)::int AS c FROM sekolah');
const m = await pool.query('SELECT COUNT(*)::int AS c FROM sync_meta');
const s = await pool.query(
  'SELECT waktu_selesai_terakhir FROM status_sinkronisasi WHERE id = 2'
);
console.log('OK — sekolah:', c.rows[0].c, '| sync_meta keys:', m.rows[0].c);
console.log('    status_sinkronisasi.waktu_selesai_terakhir:', s.rows[0]?.waktu_selesai_terakhir ?? null);
await pool.end();
