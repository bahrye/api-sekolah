import { neon } from '@neondatabase/serverless';

export const MISSING_DATABASE_URL_MSG =
  'DATABASE_URL belum dikonfigurasi. Worker/Pages: set secret DATABASE_URL (connection string Neon).';

/**
 * @param {{ DATABASE_URL?: string }} env
 */
export function hasDatabaseUrl(env) {
  return Boolean(env?.DATABASE_URL?.trim());
}

/**
 * Klien SQL Neon (PostgreSQL) — database utama.
 * @param {{ DATABASE_URL?: string }} env
 */
export function getSql(env) {
  const url = env?.DATABASE_URL?.trim();
  if (!url) throw new Error(MISSING_DATABASE_URL_MSG);
  return neon(url);
}

/** @deprecated gunakan getSql — nama lama saat masih D1 */
export function getDb(env) {
  return getSql(env);
}
