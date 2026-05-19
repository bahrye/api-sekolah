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
 * @param {Request} request
 * @param {URL} url
 * @param {{ SYNC_SECRET?: string }} env
 */
export function assertSyncAuthorized(request, url, env) {
  const provided = getProvidedSyncSecret(request, url);
  if (!isSyncAuthorized(env, provided)) {
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
  return { ok: true };
}
