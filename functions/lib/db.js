import { getSupabaseClient } from './supabase-client.js';

export const MISSING_DATABASE_URL_MSG =
  'Database Supabase belum dikonfigurasi. Pastikan SUPABASE_URL dan SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY telah diatur.';

/**
 * @param {Record<string, any>} env
 */
export function hasDatabaseUrl(env) {
  const proc = typeof process !== 'undefined' ? process.env : undefined;
  return Boolean(env?.SUPABASE_URL || proc?.SUPABASE_URL);
}

/**
 * Cek apakah menggunakan Supabase
 * @param {Record<string, any>} env
 */
export function isSupabase(env) {
  return true;
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

/** @deprecated D1 sudah tidak digunakan, beralih ke getSupabase */
export function getDb(env) {
  throw new Error('Cloudflare D1 sudah tidak digunakan. Gunakan Supabase via getSupabase().');
}

/** @deprecated gunakan getSupabase */
export function getSql(env) {
  return getDb(env);
}

