import { neon } from '@neondatabase/serverless';

/**
 * Klien SQL Neon (PostgreSQL) — database utama.
 * Set DATABASE_URL di Cloudflare Pages / Worker secrets dan .dev.vars lokal.
 * @param {{ DATABASE_URL?: string }} env
 */
export function getSql(env) {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL belum dikonfigurasi. Tambahkan di Cloudflare (Pages + Worker) atau .dev.vars'
    );
  }
  return neon(url);
}

/** @deprecated gunakan getSql — nama lama saat masih D1 */
export function getDb(env) {
  return getSql(env);
}
