import { getSupabaseClient } from './supabase-client.js';

export const MISSING_DATABASE_URL_MSG =
  'Database belum dikonfigurasi. Hubungkan binding DB (Cloudflare D1) atau SUPABASE_URL / SUPABASE_ANON_KEY.';

/**
 * @param {Record<string, any>} env
 */
export function hasDatabaseUrl(env) {
  return Boolean(env?.DB || env?.SUPABASE_URL || process.env?.SUPABASE_URL);
}

/**
 * Cek apakah menggunakan Supabase
 * @param {Record<string, any>} env
 */
export function isSupabase(env) {
  return Boolean(env?.SUPABASE_URL || process.env?.SUPABASE_URL);
}

/**
 * Klien SQL D1 (SQLite) — database D1.
 * @param {{ DB?: import('@cloudflare/workers-types').D1Database }} env
 */
export function getDb(env) {
  const db = env?.DB;
  if (!db) throw new Error(MISSING_DATABASE_URL_MSG);
  return db;
}

/**
 * Klien Supabase
 * @param {Record<string, any>} env
 */
export function getSupabase(env) {
  const client = getSupabaseClient(env);
  if (!client) throw new Error(MISSING_DATABASE_URL_MSG);
  return client;
}

/** @deprecated gunakan getDb */
export function getSql(env) {
  return getDb(env);
}

