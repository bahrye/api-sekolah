import {
  rowFromDb,
  ROW_FP_COLUMN,
  fingerprintRow,
  rowChanged,
} from './sekolah-schema.js';

/** Baris per query INSERT/UPSERT */
export const DB_UPSERT_BATCH = 40;
/** Baris per query UPDATE row_fp */
export const DB_FP_UPDATE_BATCH = 80;

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
  'satuan_pendidikan_id',
  'kode_wilayah',
  'row_fp',
];

/**
 * @param {Record<string, string>} row
 */
export function rowToDbRecord(row) {
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
    satuan_pendidikan_id: row.SatuanPendidikanId || null,
    kode_wilayah: row.KodeWilayah || null,
    row_fp: row[ROW_FP_COLUMN] ?? row.row_fp ?? '',
  };
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 */
export async function countSekolah(db) {
  const row = await db.prepare(`SELECT COUNT(*) AS c FROM sekolah`).first();
  return row?.c ?? 0;
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {number} limit
 * @param {number} offset
 */
export async function listSekolah(db, limit, offset) {
  const { results } = await db.prepare(`
    SELECT
      npsn, nama, bentuk_pendidikan, bentuk_pendidikan_group, jenis_pendidikan,
      status_satuan_pendidikan, jenjang_pendidikan, pembina, jalur_pendidikan,
      nama_desa, nama_kecamatan, nama_kabupaten, nama_provinsi, alamat_jalan, 
      satuan_pendidikan_id, kode_wilayah, row_fp
    FROM sekolah
    ORDER BY npsn
    LIMIT ? OFFSET ?
  `).bind(limit, offset).all();
  return results || [];
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {string} keyword
 * @param {number} limit
 * @param {number} offset
 */
export async function searchSekolah(db, keyword, limit, offset) {
  // 1. Jalur Cepat: Jika persis 8 digit angka, cek sebagai NPSN exact match
  if (/^\d{8}$/.test(keyword)) {
    const { results } = await db.prepare(`
      SELECT
        npsn, nama, bentuk_pendidikan, bentuk_pendidikan_group, jenis_pendidikan,
        status_satuan_pendidikan, jenjang_pendidikan, pembina, jalur_pendidikan,
        nama_desa, nama_kecamatan, nama_kabupaten, nama_provinsi, alamat_jalan,
        satuan_pendidikan_id, kode_wilayah, row_fp
      FROM sekolah
      WHERE npsn = ?
      LIMIT 1
    `).bind(keyword).all();
    
    // Jika ketemu langsung return, sangat cepat (1ms) karena pakai Primary Key
    if (results && results.length > 0) return results;
  }

  // 2. Pencarian Umum
  // Hilangkan ORDER BY npsn agar SQLite berhenti scan saat limit tercapai (Jauh lebih cepat!)
  const likeName = `%${keyword}%`;
  const likeNpsn = `${keyword}%`; // Prefix search untuk npsn lebih relevan
  
  const { results } = await db.prepare(`
    SELECT
      npsn, nama, bentuk_pendidikan, bentuk_pendidikan_group, jenis_pendidikan,
      status_satuan_pendidikan, jenjang_pendidikan, pembina, jalur_pendidikan,
      nama_desa, nama_kecamatan, nama_kabupaten, nama_provinsi, alamat_jalan,
      satuan_pendidikan_id, kode_wilayah, row_fp
    FROM sekolah
    WHERE npsn LIKE ? OR nama LIKE ?
    LIMIT ? OFFSET ?
  `).bind(likeNpsn, likeName, limit, offset).all();
  return results || [];
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {string[]} npsns
 */
export async function fetchSekolahByNpsns(db, npsns) {
  if (!npsns.length) return new Map();
  const placeholders = npsns.map(() => '?').join(',');
  const { results } = await db.prepare(`
    SELECT
      npsn, nama, bentuk_pendidikan, bentuk_pendidikan_group, jenis_pendidikan,
      status_satuan_pendidikan, jenjang_pendidikan, pembina, jalur_pendidikan,
      nama_desa, nama_kecamatan, nama_kabupaten, nama_provinsi, alamat_jalan,
      satuan_pendidikan_id, kode_wilayah, row_fp
    FROM sekolah
    WHERE npsn IN (${placeholders})
  `).bind(...npsns).all();
  return new Map((results || []).map((r) => [r.npsn, rowFromDb(r)]));
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {Record<string, string>[]} rows
 */
export async function upsertSekolahRowsBulk(db, rows) {
  if (!rows.length) return;

  const colList = UPSERT_COLS.join(', ');
  const placeholders = UPSERT_COLS.map(() => '?').join(', ');
  const updateSet = UPSERT_COLS.filter((c) => c !== 'npsn')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');

  const stmt = db.prepare(`
    INSERT INTO sekolah (${colList}) VALUES (${placeholders})
    ON CONFLICT (npsn) DO UPDATE SET ${updateSet}
  `);

  const stmts = rows.map(row => {
    const r = rowToDbRecord(row);
    return stmt.bind(
      r.npsn, r.nama, r.bentuk_pendidikan, r.bentuk_pendidikan_group, r.jenis_pendidikan,
      r.status_satuan_pendidikan, r.jenjang_pendidikan, r.pembina, r.jalur_pendidikan,
      r.nama_desa, r.nama_kecamatan, r.nama_kabupaten, r.nama_provinsi, r.alamat_jalan,
      r.satuan_pendidikan_id, r.kode_wilayah, r.row_fp
    );
  });

  // Execute in batches
  for (let i = 0; i < stmts.length; i += DB_UPSERT_BATCH) {
    const batch = stmts.slice(i, i + DB_UPSERT_BATCH);
    await db.batch(batch);
  }
}

/** @deprecated */
export async function upsertSekolahRow(db, row) {
  await upsertSekolahRowsBulk(db, [row]);
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {Record<string, string>[]} rows
 */
export async function updateRowFpBulk(db, rows) {
  if (!rows.length) return;

  const stmt = db.prepare(`UPDATE sekolah SET row_fp = ? WHERE npsn = ?`);
  const stmts = rows.map(r => {
    const npsn = r.NPSN;
    const fp = r[ROW_FP_COLUMN] ?? r.row_fp ?? '';
    return stmt.bind(fp, npsn);
  });

  for (let i = 0; i < stmts.length; i += DB_FP_UPDATE_BATCH) {
    const batch = stmts.slice(i, i + DB_FP_UPDATE_BATCH);
    await db.batch(batch);
  }
}

/** @deprecated */
export async function updateRowFpOnly(db, row) {
  await updateRowFpBulk(db, [row]);
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {Array<{ row: Record<string, string>, kind: string }>} queue
 */
export async function flushSekolahWriteQueue(db, queue) {
  const upserts = [];
  const fpOnly = [];
  for (const item of queue) {
    if (item.kind === 'fp_only') fpOnly.push(item.row);
    else upserts.push(item.row);
  }
  if (upserts.length) await upsertSekolahRowsBulk(db, upserts);
  if (fpOnly.length) await updateRowFpBulk(db, fpOnly);
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {number} limit
 */
export async function fetchRowsMissingRowFp(db, limit) {
  const { results } = await db.prepare(`
    SELECT
      npsn, nama, bentuk_pendidikan, bentuk_pendidikan_group, jenis_pendidikan,
      status_satuan_pendidikan, jenjang_pendidikan, pembina, jalur_pendidikan,
      nama_desa, nama_kecamatan, nama_kabupaten, nama_provinsi, alamat_jalan, row_fp
    FROM sekolah
    WHERE row_fp IS NULL OR row_fp = ''
    LIMIT ?
  `).bind(limit).all();
  return (results || []).map(rowFromDb);
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 */
export async function countNullRowFp(db) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM sekolah WHERE row_fp IS NULL OR row_fp = ''`).first();
  return row?.n ?? 0;
}

/**
 * @param {import('@cloudflare/workers-types').D1Database} db
 * @param {number} batchSize
 */
export async function backfillRowFpBatchDb(db, batchSize) {
  const rows = await fetchRowsMissingRowFp(db, batchSize);
  if (!rows.length) return { processed: 0, updated: 0, done: true };

  const fingerprints = await Promise.all(rows.map((row) => fingerprintRow(row)));
  for (let i = 0; i < rows.length; i++) {
    rows[i][ROW_FP_COLUMN] = fingerprints[i];
  }
  await updateRowFpBulk(db, rows);

  return { processed: rows.length, updated: rows.length, done: false };
}

export { fingerprintRow, rowChanged };
