const jsonHeaders = {
  'Content-Type': 'application/json;charset=UTF-8',
  'Access-Control-Allow-Origin': '*',
};

/**
 * API selalu JSON; hindari respons HTML bawaan edge saat error.
 */
const BLOCKED_PUBLIC_PATHS = new Set([
  '/backfill-row-fp.html',
  '/backfill-row-fp',
  '/status-sync',
  '/sync-status',
]);

/** Halaman / API sinkron internal — tidak untuk publik */
function isBlockedPublicSyncPath(pathname) {
  const p = pathname.replace(/\/$/, '') || '/';
  if (BLOCKED_PUBLIC_PATHS.has(p)) return true;
  if (p === '/api/sync' || p.startsWith('/api/sync/')) return true;
  if (p === '/api/backfill-row-fp' || p.startsWith('/api/backfill-row-fp/')) return true;
  if (p === '/api/row-fp-status' || p.startsWith('/api/row-fp-status/')) return true;
  return false;
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const isApi = url.pathname.startsWith('/api/');

  if (isBlockedPublicSyncPath(url.pathname)) {
    if (isApi) {
      return new Response(JSON.stringify({ status: 'error', message: 'Not found' }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
    return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }

  try {
    const response = await context.next();
    if (!isApi) return response;

    const ct = response.headers.get('content-type') || '';
    if (response.status >= 500 && ct.includes('text/html')) {
      return new Response(
        JSON.stringify({
          status: 'error',
          message:
            'Batas CPU Cloudflare Pages (kode 1102). Terjadi beban CPU tinggi pada edge function.',
          http_status: response.status,
          retry_after_seconds: 10,
        }),
        { status: response.status, headers: jsonHeaders }
      );
    }
    return response;
  } catch (err) {
    if (isApi) {
      return new Response(
        JSON.stringify({ status: 'error', message: err?.message || 'Internal error' }),
        { status: 500, headers: jsonHeaders }
      );
    }
    throw err;
  }
}
