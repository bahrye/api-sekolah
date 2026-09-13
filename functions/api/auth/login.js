import { getSupabase } from '../../lib/db.js';
import { createSessionToken, createAuthCookie } from '../../lib/auth.js';

async function sha256Hex(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    let email = '';
    let password = '';

    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = await request.json().catch(() => ({}));
      email = (body.email || '').trim();
      password = body.password || '';
    } else {
      const formData = await request.formData().catch(() => new FormData());
      email = (formData.get('email') || '').toString().trim();
      password = (formData.get('password') || '').toString();
    }

    if (!email || !password) {
      return new Response(JSON.stringify({ ok: false, error: 'Email dan password wajib diisi.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const supabase = getSupabase(env);
    let isAuthenticated = false;

    // Verifikasi melalui Supabase Auth (Tersimpan aman di skema internal auth.users)
    try {
      const { data: authData, error: authErr } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (!authErr && authData?.user) {
        isAuthenticated = true;
      }
    } catch (e) {
      console.warn('Supabase Auth check error:', e.message);
    }

    if (!isAuthenticated) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Email atau password yang Anda masukkan salah.' }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Login sukses: Buat token sesi
    const token = await createSessionToken(email, env);
    const isHttps = new URL(request.url).protocol === 'https:';
    const cookie = createAuthCookie(token, isHttps);

    return new Response(
      JSON.stringify({
        ok: true,
        email,
        message: 'Login berhasil.',
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': cookie,
        },
      }
    );
  } catch (err) {
    console.error('Login error:', err);
    return new Response(
      JSON.stringify({ ok: false, error: 'Terjadi kesalahan sistem saat memproses login.' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
