import {
  rowFromNeon,
  ROW_FP_COLUMN,
  fingerprintRow,
  rowChanged,
} from './sekolah-schema.js';

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 */
export async function countSekolah(sql) {
  const rows = await sql`SELECT COUNT(*)::int AS c FROM sekolah`;
  return rows[0]?.c ?? 0;
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {number} limit
 * @param {number} offset
 */
export async function listSekolah(sql, limit, offset) {
  return sql`
    SELECT
      npsn, nama, bentuk_pendidikan, bentuk_pendidikan_group, jenis_pendidikan,
      status_satuan_pendidikan, jenjang_pendidikan, pembina, jalur_pendidikan,
      nama_desa, nama_kecamatan, nama_kabupaten, nama_provinsi, alamat_jalan, row_fp
    FROM sekolah
    ORDER BY npsn
    LIMIT ${limit} OFFSET ${offset}
  `;
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {string} keyword
 * @param {number} limit
 * @param {number} offset
 */
export async function searchSekolah(sql, keyword, limit, offset) {
  const like = `%${keyword}%`;
  return sql`
    SELECT
      npsn, nama, bentuk_pendidikan, bentuk_pendidikan_group, jenis_pendidikan,
      status_satuan_pendidikan, jenjang_pendidikan, pembina, jalur_pendidikan,
      nama_desa, nama_kecamatan, nama_kabupaten, nama_provinsi, alamat_jalan, row_fp
    FROM sekolah
    WHERE npsn ILIKE ${like} OR nama ILIKE ${like}
    ORDER BY npsn
    LIMIT ${limit} OFFSET ${offset}
  `;
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {string[]} npsns
 */
export async function fetchSekolahByNpsns(sql, npsns) {
  if (!npsns.length) return new Map();
  const rows = await sql`
    SELECT
      npsn, nama, bentuk_pendidikan, bentuk_pendidikan_group, jenis_pendidikan,
      status_satuan_pendidikan, jenjang_pendidikan, pembina, jalur_pendidikan,
      nama_desa, nama_kecamatan, nama_kabupaten, nama_provinsi, alamat_jalan, row_fp
    FROM sekolah
    WHERE npsn = ANY(${npsns})
  `;
  return new Map(rows.map((r) => [r.npsn, rowFromNeon(r)]));
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {Record<string, string>} row
 */
export async function upsertSekolahRow(sql, row) {
  const fp = row[ROW_FP_COLUMN] ?? row.row_fp ?? '';
  await sql`
    INSERT INTO sekolah (
      npsn, nama, bentuk_pendidikan, bentuk_pendidikan_group, jenis_pendidikan,
      status_satuan_pendidikan, jenjang_pendidikan, pembina, jalur_pendidikan,
      nama_desa, nama_kecamatan, nama_kabupaten, nama_provinsi, alamat_jalan, row_fp
    ) VALUES (
      ${row.NPSN}, ${row.Nama}, ${row.Bentuk}, ${row.BentukGroup || null}, ${row.Jenis},
      ${row.Status}, ${row.Jenjang}, ${row.Pembina || null}, ${row.Jalur || null},
      ${row.Kelurahan || null}, ${row.Kecamatan || null}, ${row.Kabupaten || null},
      ${row.Provinsi || null}, ${row.Alamat || null}, ${fp}
    )
    ON CONFLICT (npsn) DO UPDATE SET
      nama = EXCLUDED.nama,
      bentuk_pendidikan = EXCLUDED.bentuk_pendidikan,
      bentuk_pendidikan_group = EXCLUDED.bentuk_pendidikan_group,
      jenis_pendidikan = EXCLUDED.jenis_pendidikan,
      status_satuan_pendidikan = EXCLUDED.status_satuan_pendidikan,
      jenjang_pendidikan = EXCLUDED.jenjang_pendidikan,
      pembina = EXCLUDED.pembina,
      jalur_pendidikan = EXCLUDED.jalur_pendidikan,
      nama_desa = EXCLUDED.nama_desa,
      nama_kecamatan = EXCLUDED.nama_kecamatan,
      nama_kabupaten = EXCLUDED.nama_kabupaten,
      nama_provinsi = EXCLUDED.nama_provinsi,
      alamat_jalan = EXCLUDED.alamat_jalan,
      row_fp = EXCLUDED.row_fp
  `;
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {Record<string, string>} row
 */
export async function updateRowFpOnly(sql, row) {
  const fp = row[ROW_FP_COLUMN] ?? row.row_fp ?? '';
  await sql`UPDATE sekolah SET row_fp = ${fp} WHERE npsn = ${row.NPSN}`;
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {Record<string, string>[]} rows
 * @param {'insert' | 'update' | 'fp_only'} mode
 */
export async function applySekolahWrites(sql, rows, mode) {
  for (const row of rows) {
    if (mode === 'fp_only') await updateRowFpOnly(sql, row);
    else await upsertSekolahRow(sql, row);
  }
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {number} limit
 */
export async function fetchRowsMissingRowFp(sql, limit) {
  const rows = await sql`
    SELECT
      npsn, nama, bentuk_pendidikan, bentuk_pendidikan_group, jenis_pendidikan,
      status_satuan_pendidikan, jenjang_pendidikan, pembina, jalur_pendidikan,
      nama_desa, nama_kecamatan, nama_kabupaten, nama_provinsi, alamat_jalan, row_fp
    FROM sekolah
    WHERE row_fp IS NULL OR row_fp = ''
    LIMIT ${limit}
  `;
  return rows.map(rowFromNeon);
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 */
export async function countNullRowFp(sql) {
  const rows = await sql`
    SELECT COUNT(*)::int AS n FROM sekolah WHERE row_fp IS NULL OR row_fp = ''
  `;
  return rows[0]?.n ?? 0;
}

/**
 * Proses batch backfill row_fp.
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {number} batchSize
 */
export async function backfillRowFpBatchPg(sql, batchSize) {
  const rows = await fetchRowsMissingRowFp(sql, batchSize);
  if (!rows.length) return { processed: 0, updated: 0, done: true };

  for (const row of rows) {
    row[ROW_FP_COLUMN] = await fingerprintRow(row);
    await updateRowFpOnly(sql, row);
  }
  return { processed: rows.length, updated: rows.length, done: false };
}

export { fingerprintRow, rowChanged };
