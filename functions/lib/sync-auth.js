/**
 * Otorisasi sinkron manual — secret dari env SYNC_SECRET (header atau query).
 */

/**
 * @param {Request} request
 * @param {URL} url
 */
export function getProvidedSyncSecret(request, url) {
  return url.searchParams.get('secret') || request.headers.get('X-Sync-Secret') || '';
}

/**
 * @param {{ SYNC_SECRET?: string }} env
 * @param {string} provided
 */
export function isSyncAuthorized(env, provided) {
  const envSecret = env.SYNC_SECRET;
  if (!envSecret) return false;
  return provided === envSecret;
}

/**
 * Permintaan dari dashboard status (secret salah → abaikan, jangan hentikan sync).
 * @param {Request} request
 * @param {URL} url
 */
export function isSoftControlRequest(request, url) {
  return request.headers.get('X-Sync-Soft') === '1' || url.searchParams.get('soft') === '1';
}

/**
 * @param {Request} request
 * @param {URL} url
 * @param {{ SYNC_SECRET?: string }} env
 * @param {{ soft?: boolean }} [opts]
 */
export function resolveSyncAuth(request, url, env, opts = {}) {
  const provided = getProvidedSyncSecret(request, url);
  const authorized = isSyncAuthorized(env, provided);
  const soft = opts.soft === true || isSoftControlRequest(request, url);

  if (!authorized) {
    if (soft) {
      return {
        ok: false,
        soft: true,
        ignored: true,
        message: 'SYNC_SECRET tidak valid — tidak ada perubahan.',
      };
    }
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          status: 'error',
          message: 'Unauthorized. Sinkron manual memerlukan SYNC_SECRET yang valid.',
        }),
        { status: 401, headers: { 'Content-Type': 'application/json;charset=UTF-8' } }
      ),
    };
  }
  return { ok: true, provided };
}

/**
 * @param {Request} request
 * @param {URL} url
 * @param {{ SYNC_SECRET?: string }} env
 */
export function assertSyncAuthorized(request, url, env) {
  return resolveSyncAuth(request, url, env, { soft: false });
}
