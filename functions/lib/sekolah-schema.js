/** Kolom tabel sekolah — selaras dengan API belajar.id */

export const FIELDS = [
  'NPSN',
  'Nama',
  'Bentuk',
  'BentukGroup',
  'Jenis',
  'Status',
  'Jenjang',
  'Pembina',
  'Jalur',
  'Kelurahan',
  'Kecamatan',
  'Kabupaten',
  'Provinsi',
  'Alamat',
];

/** Kolom untuk respons API publik (tanpa kolom internal) */
export const SELECT_COLS = FIELDS.join(', ');

/** Kolom internal — hash isi baris untuk skip UPDATE */
export const ROW_FP_COLUMN = 'row_fp';

/** Baris dari PostgreSQL (snake_case) → format internal sync */
export function rowFromNeon(r) {
  return {
    NPSN: r.npsn,
    Nama: r.nama,
    Bentuk: r.bentuk_pendidikan,
    BentukGroup: r.bentuk_pendidikan_group,
    Jenis: r.jenis_pendidikan,
    Status: r.status_satuan_pendidikan,
    Jenjang: r.jenjang_pendidikan,
    Pembina: r.pembina,
    Jalur: r.jalur_pendidikan,
    Kelurahan: r.nama_desa,
    Kecamatan: r.nama_kecamatan,
    Kabupaten: r.nama_kabupaten,
    Provinsi: r.nama_provinsi,
    Alamat: r.alamat_jalan,
    [ROW_FP_COLUMN]: r.row_fp,
  };
}

export function formatNeonRowResponse(r) {
  return formatRowResponse(rowFromNeon(r));
}
export const ROW_FP_VERSION = '1';

const ROW_HASH_FIELDS = FIELDS.filter((k) => k !== 'NPSN');

/**
 * Normalisasi nilai dari API/SQL agar hash stabil (spasi, null).
 * @param {unknown} value
 */
export function normalizeFieldValue(value) {
  if (value == null) return '';
  return String(value).trim();
}

/**
 * @param {Record<string, unknown>} item
 */
export function mapFromApi(item) {
  return {
    NPSN: normalizeFieldValue(item.npsn ?? item.NPSN),
    Nama: normalizeFieldValue(item.nama ?? item.Nama),
    Bentuk: normalizeFieldValue(item.bentukPendidikan ?? item.Bentuk),
    BentukGroup: normalizeFieldValue(item.bentukPendidikanGroup ?? item.BentukGroup),
    Jenis: normalizeFieldValue(item.jenisPendidikan ?? item.Jenis),
    Status: normalizeFieldValue(item.statusSatuanPendidikan ?? item.Status),
    Jenjang: normalizeFieldValue(item.jenjangPendidikan ?? item.Jenjang),
    Pembina: normalizeFieldValue(item.pembina ?? item.Pembina),
    Jalur: normalizeFieldValue(item.jalurPendidikan ?? item.Jalur),
    Kelurahan: normalizeFieldValue(item.namaDesa ?? item.Kelurahan),
    Kecamatan: normalizeFieldValue(item.namaKecamatan ?? item.Kecamatan),
    Kabupaten: normalizeFieldValue(item.namaKabupaten ?? item.Kabupaten),
    Provinsi: normalizeFieldValue(item.namaProvinsi ?? item.Provinsi),
    Alamat: normalizeFieldValue(item.alamatJalan ?? item.Alamat),
  };
}

/**
 * Hash isi baris (bukan per kolom kuota). Dipakai untuk skip UPDATE jika data sama.
 * @param {Record<string, string>} row
 */
export async function fingerprintRow(row) {
  const payload = ROW_FP_VERSION + '|' + ROW_HASH_FIELDS.map((k) => row[k] ?? '').join('\x1f');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {Record<string, string>} row
 */
export function formatRowResponse(row) {
  const pembina = row.Pembina ? row.Pembina.replace(/;/g, '') : null;
  return {
    npsn: row.NPSN,
    nama: row.Nama,
    bentuk_pendidikan: row.Bentuk,
    bentuk_pendidikan_group: row.BentukGroup || null,
    jenis_pendidikan: row.Jenis,
    status_satuan_pendidikan: row.Status,
    jenjang_pendidikan: row.Jenjang,
    pembina,
    jalur_pendidikan: row.Jalur,
    nama_desa: row.Kelurahan,
    nama_kecamatan: row.Kecamatan,
    nama_kabupaten: row.Kabupaten,
    nama_provinsi: row.Provinsi || null,
    alamat_jalan: row.Alamat,
  };
}

/**
 * @param {Record<string, string>} a
 * @param {Record<string, string>} b
 */
export function rowChanged(a, b) {
  for (const key of FIELDS) {
    if (key === 'NPSN') continue;
    if (normalizeFieldValue(a[key]) !== normalizeFieldValue(b[key])) return true;
  }
  return false;
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {Record<string, string>} row
 */
export function buildRowFpOnlyStatement(db, row) {
  return db
    .prepare(`UPDATE sekolah SET ${ROW_FP_COLUMN} = ? WHERE NPSN = ?`)
    .bind(row[ROW_FP_COLUMN] ?? row.row_fp ?? '', row.NPSN);
}

export const INSERT_COLUMNS = `${SELECT_COLS}, ${ROW_FP_COLUMN}`;
export const INSERT_PLACEHOLDERS = [...FIELDS, ROW_FP_COLUMN].map(() => '?').join(', ');

const UPDATE_DATA_COLS = FIELDS.filter((k) => k !== 'NPSN');

/** @param {Record<string, string>} row */
export function insertBindValues(row) {
  return [...FIELDS.map((k) => row[k] ?? ''), row[ROW_FP_COLUMN] ?? row.row_fp ?? ''];
}

/**
 * @param {Record<string, string>} row
 */
export function updateBindValues(row) {
  return [
    ...UPDATE_DATA_COLS.map((k) => row[k] ?? ''),
    row[ROW_FP_COLUMN] ?? row.row_fp ?? '',
    row.NPSN,
  ];
}

export const UPDATE_SET_CLAUSE = [...UPDATE_DATA_COLS.map((k) => `${k} = ?`), `${ROW_FP_COLUMN} = ?`].join(
  ', '
);
