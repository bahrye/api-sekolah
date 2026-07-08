export const MISSING_DATABASE_URL_MSG =
  'Database D1 belum dikonfigurasi. Worker/Pages: set binding DB di wrangler.toml.';

/**
 * @param {{ DB?: import('@cloudflare/workers-types').D1Database }} env
 */
export function hasDatabaseUrl(env) {
  return Boolean(env?.DB);
}

/**
 * Klien SQL D1 (SQLite) — database utama.
 * @param {{ DB?: import('@cloudflare/workers-types').D1Database }} env
 */
export function getDb(env) {
  const db = env?.DB;
  if (!db) throw new Error(MISSING_DATABASE_URL_MSG);
  return db;
}

/** @deprecated gunakan getDb */
export function getSql(env) {
  return getDb(env);
}
