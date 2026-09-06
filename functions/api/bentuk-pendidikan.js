import { VALID_BENTUK } from '../lib/sync-supabase-core.js';

export async function onRequest(context) {
  const { request } = context;

  if (request.method === 'GET') {
    return new Response(JSON.stringify({ ok: true, data: VALID_BENTUK }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  return new Response(JSON.stringify({ ok: true, message: 'Operasi bentuk pendidikan selesai' }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
