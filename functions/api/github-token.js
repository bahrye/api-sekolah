import { getSupabase } from '../lib/db.js';
import { getSessionFromRequest } from '../lib/auth.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const envToken = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (envToken) {
    return new Response(JSON.stringify({ ok: true, configured: true, source: 'env' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabase = getSupabase(env);
    const { data: row } = await supabase
      .from('cache_data')
      .select('value')
      .eq('key', 'github_token')
      .maybeSingle();

    if (row && row.value) {
      return new Response(JSON.stringify({ ok: true, configured: true, source: 'database' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
  } catch (e) {
    console.error('Error checking github_token in DB:', e.message);
  }

  return new Response(JSON.stringify({ ok: true, configured: false, source: 'none' }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const token = (body.token || '').trim();

    if (!token) {
      return new Response(JSON.stringify({ ok: false, error: 'Token GitHub tidak boleh kosong.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const supabase = getSupabase(env);
    const { error: upsertErr } = await supabase.from('cache_data').upsert({
      key: 'github_token',
      value: token,
      updated_at: new Date().toISOString(),
    });

    if (upsertErr) {
      throw new Error(upsertErr.message);
    }

    return new Response(
      JSON.stringify({ ok: true, message: 'Token GitHub berhasil disimpan ke database.' }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: 'Gagal menyimpan token: ' + err.message }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
