import { createClearAuthCookie } from '../../lib/auth.js';

export async function onRequest(context) {
  const { request } = context;
  const isHttps = new URL(request.url).protocol === 'https:';
  const cookie = createClearAuthCookie(isHttps);

  const url = new URL(request.url);
  // Jika diakses via link GET biasa, redirect ke /login
  if (request.method === 'GET' || url.searchParams.get('redirect') === 'true') {
    return new Response(null, {
      status: 302,
      headers: {
        'Location': '/login',
        'Set-Cookie': cookie,
      },
    });
  }

  return new Response(JSON.stringify({ ok: true, message: 'Logout berhasil.' }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': cookie,
    },
  });
}
