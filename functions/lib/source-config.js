/**
 * Konfigurasi URL Sumber Data
 * Mengutamakan environment variable agar dapat disesuaikan tanpa mengubah kode.
 */
const _D1 = 'aHR0cHM6Ly9hcGkuZGF0YS5iZWxhamFyLmlkL2RhdGEtcG9ydGFsLWJhY2tlbmQvdjIvbWFzdGVyLWRhdGEvc2F0dWFuLXBlbmRpZGlrYW4vZGFmdGFyLWRhdGEtaW5kdWs=';
const _D2 = 'aHR0cHM6Ly9hcGkuZGF0YS5iZWxhamFyLmlkL2RhdGEtcG9ydGFsLWJhY2tlbmQvdjIvbWFzdGVyLWRhdGEvc2F0dWFuLXBlbmRpZGlrYW4vanVtbGFoLWRhdGEtaW5kdWs=';

function decode(b64) {
  if (typeof atob === 'function') return atob(b64);
  if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8');
  return '';
}

export function getDataSourceUrl(env) {
  const proc = typeof process !== 'undefined' ? process.env : undefined;
  return env?.DATA_SOURCE_URL || proc?.DATA_SOURCE_URL || decode(_D1);
}

export function getDataSourceJumlahUrl(env) {
  const proc = typeof process !== 'undefined' ? process.env : undefined;
  return env?.DATA_SOURCE_JUMLAH_URL || proc?.DATA_SOURCE_JUMLAH_URL || decode(_D2);
}
