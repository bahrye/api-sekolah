const jsonHeaders = {
  'Content-Type': 'application/json;charset=UTF-8',
  'Access-Control-Allow-Origin': '*',
};

/**
 * API selalu JSON; hindari respons HTML bawaan edge saat error.
 */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const isApi = url.pathname.startsWith('/api/');

  try {
    const response = await context.next();
    if (!isApi) return response;

    const ct = response.headers.get('content-type') || '';
    if (response.status >= 500 && ct.includes('text/html')) {
      return new Response(
        JSON.stringify({
          status: 'error',
          message:
            'Batas CPU Cloudflare Pages (kode 1102). Coba maxPages=10 atau maxPages=20 jika data sedikit berubah; atau andalkan Cron Worker /tick.',
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
