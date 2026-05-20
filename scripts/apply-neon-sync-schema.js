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

const sql = fs.readFileSync(path.join(root, 'migrations', 'neon_sync_tables.sql'), 'utf8');
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: true } });
await pool.query(sql);
const c = await pool.query('SELECT COUNT(*)::int AS c FROM sekolah');
const m = await pool.query('SELECT COUNT(*)::int AS c FROM sync_meta');
console.log('OK — sekolah:', c.rows[0].c, '| sync_meta keys:', m.rows[0].c);
await pool.end();
