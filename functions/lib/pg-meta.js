/**
 * Helper sync_meta di PostgreSQL (Neon).
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {string} key
 * @param {string | number | boolean} value
 */
export async function metaUpsert(sql, key, value) {
  await sql`
    INSERT INTO sync_meta (key, value) VALUES (${key}, ${String(value)})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {string[]} keys
 */
export async function metaGetMany(sql, keys) {
  if (!keys.length) return {};
  const rows = await sql`SELECT key, value FROM sync_meta WHERE key = ANY(${keys})`;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {string} key
 */
export async function metaGet(sql, key) {
  const rows = await sql`SELECT value FROM sync_meta WHERE key = ${key}`;
  return rows[0]?.value ?? null;
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {string} key
 */
export async function metaDelete(sql, key) {
  await sql`DELETE FROM sync_meta WHERE key = ${key}`;
}
