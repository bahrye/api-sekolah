import { createClient } from '@supabase/supabase-js';

let cachedClient = null;

/**
 * Mendapatkan Supabase client untuk Worker / Cloudflare Pages / Node
 * @param {Record<string, any>} [env]
 */
export function getSupabaseClient(env = {}) {
  const proc = typeof process !== 'undefined' ? process.env : undefined;
  const url = env.SUPABASE_URL || proc?.SUPABASE_URL;
  const key =
    env.SUPABASE_SERVICE_ROLE_KEY ||
    env.SUPABASE_ANON_KEY ||
    proc?.SUPABASE_SERVICE_ROLE_KEY ||
    proc?.SUPABASE_ANON_KEY;

  if (!url || !key) {
    return null;
  }

  if (!cachedClient || cachedClient.supabaseUrl !== url) {
    cachedClient = createClient(url, key, {
      auth: { persistSession: false },
    });
  }

  return cachedClient;
}
