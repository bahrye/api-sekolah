import {
  rowFromNeon,
  ROW_FP_COLUMN,
  fingerprintRow,
  rowChanged,
} from './sekolah-schema.js';

/** Baris per query INSERT/UPSERT (hemat subrequest Worker → Neon) */
export const PG_UPSERT_BATCH = 40;
/** Baris per query UPDATE row_fp */
export const PG_FP_UPDATE_BATCH = 80;

const UPSERT_COLS = [
  'npsn',
  'nama',
  'bentuk_pendidikan',
  'bentuk_pendidikan_group',
  'jenis_pendidikan',
  'status_satuan_pendidikan',
  'jenjang_pendidikan',
  'pembina',
  'jalur_pendidikan',
  'nama_desa',
  'nama_kecamatan',
  'nama_kabupaten',
  'nama_provinsi',
  'alamat_jalan',
  'row_fp',
];

/**
 * @param {Record<string, string>} row
 */
export function rowToNeonRecord(row) {
  return {
    npsn: row.NPSN,
    nama: row.Nama ?? '',
    bentuk_pendidikan: row.Bentuk ?? null,
    bentuk_pendidikan_group: row.BentukGroup || null,
    jenis_pendidikan: row.Jenis ?? null,
    status_satuan_pendidikan: row.Status ?? null,
    jenjang_pendidikan: row.Jenjang ?? null,
    pembina: row.Pembina || null,
    jalur_pendidikan: row.Jalur || null,
    nama_desa: row.Kelurahan || null,
    nama_kecamatan: row.Kecamatan || null,
    nama_kabupaten: row.Kabupaten || null,
    nama_provinsi: row.Provinsi || null,
    alamat_jalan: row.Alamat || null,
    row_fp: row[ROW_FP_COLUMN] ?? row.row_fp ?? '',
  };
}

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
 * @param {Record<string, string>[]} rows
 */
export async function upsertSekolahRowsBulk(sql, rows) {
  if (!rows.length) return;

  for (let i = 0; i < rows.length; i += PG_UPSERT_BATCH) {
    const slice = rows.slice(i, i + PG_UPSERT_BATCH);
    const params = [];
    const tuples = slice.map((row) => {
      const r = rowToNeonRecord(row);
      const base = params.length + 1;
      params.push(
        r.npsn,
        r.nama,
        r.bentuk_pendidikan,
        r.bentuk_pendidikan_group,
        r.jenis_pendidikan,
        r.status_satuan_pendidikan,
        r.jenjang_pendidikan,
        r.pembina,
        r.jalur_pendidikan,
        r.nama_desa,
        r.nama_kecamatan,
        r.nama_kabupaten,
        r.nama_provinsi,
        r.alamat_jalan,
        r.row_fp
      );
      const ph = Array.from({ length: 15 }, (_, j) => `$${base + j}`);
      return `(${ph.join(',')})`;
    });

    const colList = UPSERT_COLS.join(', ');
    const updateSet = UPSERT_COLS.filter((c) => c !== 'npsn')
      .map((c) => `${c} = EXCLUDED.${c}`)
      .join(', ');

    await sql.query(
      `INSERT INTO sekolah (${colList}) VALUES ${tuples.join(',')}
       ON CONFLICT (npsn) DO UPDATE SET ${updateSet}`,
      params
    );
  }
}

/** @deprecated gunakan upsertSekolahRowsBulk */
export async function upsertSekolahRow(sql, row) {
  await upsertSekolahRowsBulk(sql, [row]);
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {Record<string, string>[]} rows
 */
export async function updateRowFpBulk(sql, rows) {
  if (!rows.length) return;

  for (let i = 0; i < rows.length; i += PG_FP_UPDATE_BATCH) {
    const slice = rows.slice(i, i + PG_FP_UPDATE_BATCH);
    const npsns = slice.map((r) => r.NPSN);
    const fps = slice.map((r) => r[ROW_FP_COLUMN] ?? r.row_fp ?? '');
    await sql`
      UPDATE sekolah AS s
      SET row_fp = u.fp
      FROM unnest(${npsns}::text[], ${fps}::text[]) AS u(npsn, fp)
      WHERE s.npsn = u.npsn
    `;
  }
}

/** @deprecated */
export async function updateRowFpOnly(sql, row) {
  await updateRowFpBulk(sql, [row]);
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {Array<{ row: Record<string, string>, kind: string }>} queue
 */
export async function flushSekolahWriteQueue(sql, queue) {
  const upserts = [];
  const fpOnly = [];
  for (const item of queue) {
    if (item.kind === 'fp_only') fpOnly.push(item.row);
    else upserts.push(item.row);
  }
  if (upserts.length) await upsertSekolahRowsBulk(sql, upserts);
  if (fpOnly.length) await updateRowFpBulk(sql, fpOnly);
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
 * Backfill row_fp — 1 SELECT + ceil(n/batch) UPDATE (bukan 2× per baris).
 * @param {import('@neondatabase/serverless').NeonQueryFunction} sql
 * @param {number} batchSize
 */
export async function backfillRowFpBatchPg(sql, batchSize) {
  const rows = await fetchRowsMissingRowFp(sql, batchSize);
  if (!rows.length) return { processed: 0, updated: 0, done: true };

  const fingerprints = await Promise.all(rows.map((row) => fingerprintRow(row)));
  for (let i = 0; i < rows.length; i++) {
    rows[i][ROW_FP_COLUMN] = fingerprints[i];
  }
  await updateRowFpBulk(sql, rows);

  return { processed: rows.length, updated: rows.length, done: false };
}

export { fingerprintRow, rowChanged };
