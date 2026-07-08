/**
 * Helper sync_meta di Cloudflare D1 (SQLite).
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {string} key
 * @param {string | number | boolean} value
 */
export async function metaUpsert(db, key, value) {
  await db.prepare(`
    INSERT INTO sync_meta (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).bind(key, String(value)).run();
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {string[]} keys
 */
export async function metaGetMany(db, keys) {
  if (!keys.length) return {};
  const placeholders = keys.map(() => '?').join(',');
  const { results } = await db.prepare(`SELECT key, value FROM sync_meta WHERE key IN (${placeholders})`).bind(...keys).all();
  return Object.fromEntries((results || []).map((r) => [r.key, r.value]));
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {string} key
 */
export async function metaGet(db, key) {
  const row = await db.prepare(`SELECT value FROM sync_meta WHERE key = ?`).bind(key).first();
  return row?.value ?? null;
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {string} key
 */
export async function metaDelete(db, key) {
  await db.prepare(`DELETE FROM sync_meta WHERE key = ?`).bind(key).run();
}
