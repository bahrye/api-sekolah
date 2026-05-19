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

/** Kolom internal — hash isi baris untuk hemat tulis D1 */
export const ROW_FP_COLUMN = 'row_fp';
export const ROW_FP_VERSION = '1';

const ROW_HASH_FIELDS = FIELDS.filter((k) => k !== 'NPSN');

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
 * @param {Record<string, unknown>} item
 */
export function mapFromApi(item) {
  return {
    NPSN: String(item.npsn ?? item.NPSN ?? ''),
    Nama: String(item.nama ?? item.Nama ?? ''),
    Bentuk: String(item.bentukPendidikan ?? item.Bentuk ?? ''),
    BentukGroup: String(item.bentukPendidikanGroup ?? item.BentukGroup ?? ''),
    Jenis: String(item.jenisPendidikan ?? item.Jenis ?? ''),
    Status: String(item.statusSatuanPendidikan ?? item.Status ?? ''),
    Jenjang: String(item.jenjangPendidikan ?? item.Jenjang ?? ''),
    Pembina: String(item.pembina ?? item.Pembina ?? ''),
    Jalur: String(item.jalurPendidikan ?? item.Jalur ?? ''),
    Kelurahan: String(item.namaDesa ?? item.Kelurahan ?? ''),
    Kecamatan: String(item.namaKecamatan ?? item.Kecamatan ?? ''),
    Kabupaten: String(item.namaKabupaten ?? item.Kabupaten ?? ''),
    Provinsi: String(item.namaProvinsi ?? item.Provinsi ?? ''),
    Alamat: String(item.alamatJalan ?? item.Alamat ?? ''),
  };
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
    if ((a[key] ?? '') !== (b[key] ?? '')) return true;
  }
  return false;
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
