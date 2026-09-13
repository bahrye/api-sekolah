export const COOKIE_NAME = 'sync_admin_session';

async function getSecretKey(env) {
  const secret = env?.SYNC_SECRET || env?.CRON_SECRET || 'sync-admin-default-secret-key-39prov';
  const encoder = new TextEncoder();
  return await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function stringToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToString(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

export async function createSessionToken(email, env) {
  const payload = {
    email,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (7 * 24 * 60 * 60), // 7 hari
  };
  const dataStr = JSON.stringify(payload);
  const dataBase64 = stringToBase64(dataStr);

  const key = await getSecretKey(env);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(dataBase64));
  
  let sigBinary = '';
  const sigBytes = new Uint8Array(signature);
  for (let i = 0; i < sigBytes.byteLength; i++) {
    sigBinary += String.fromCharCode(sigBytes[i]);
  }
  const sigBase64 = btoa(sigBinary);

  return `${dataBase64}.${sigBase64}`;
}

export async function verifySessionToken(token, env) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  try {
    const [dataBase64, sigBase64] = token.split('.');
    const key = await getSecretKey(env);

    const sigStr = atob(sigBase64);
    const sigBytes = new Uint8Array(sigStr.length);
    for (let i = 0; i < sigStr.length; i++) {
      sigBytes[i] = sigStr.charCodeAt(i);
    }

    const isValid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      new TextEncoder().encode(dataBase64)
    );

    if (!isValid) return null;

    const payload = JSON.parse(base64ToString(dataBase64));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const parts = c.trim().split('=');
    const k = parts[0];
    const v = parts.slice(1).join('=');
    if (k) cookies[k] = decodeURIComponent(v);
  });
  return cookies;
}

export async function getSessionFromRequest(request, env) {
  const cookieHeader = request.headers.get('Cookie');
  const cookies = parseCookies(cookieHeader);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  return await verifySessionToken(token, env);
}

export function createAuthCookie(token, isSecure = true) {
  const secureFlag = isSecure ? '; Secure' : '';
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}${secureFlag}`;
}

export function createClearAuthCookie(isSecure = true) {
  const secureFlag = isSecure ? '; Secure' : '';
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secureFlag}`;
}
