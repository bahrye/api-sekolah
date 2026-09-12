/**
 * Konfigurasi URL Sumber Data untuk Node.js Scripts
 */
const _D1 = 'aHR0cHM6Ly9hcGkuZGF0YS5iZWxhamFyLmlkL2RhdGEtcG9ydGFsLWJhY2tlbmQvdjIvbWFzdGVyLWRhdGEvc2F0dWFuLXBlbmRpZGlrYW4vZGFmdGFyLWRhdGEtaW5kdWs=';
const _D2 = 'aHR0cHM6Ly9hcGkuZGF0YS5iZWxhamFyLmlkL2RhdGEtcG9ydGFsLWJhY2tlbmQvdjIvbWFzdGVyLWRhdGEvc2F0dWFuLXBlbmRpZGlrYW4vanVtbGFoLWRhdGEtaW5kdWs=';

function decode(b64) {
  return Buffer.from(b64, 'base64').toString('utf8');
}

function getDataSourceUrl() {
  return process.env.DATA_SOURCE_URL || decode(_D1);
}

function getDataSourceJumlahUrl() {
  return process.env.DATA_SOURCE_JUMLAH_URL || decode(_D2);
}

module.exports = {
  getDataSourceUrl,
  getDataSourceJumlahUrl,
};
