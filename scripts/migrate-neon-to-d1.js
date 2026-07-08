import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const COLUMNS = [
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
  'row_fp'
];

function loadEnvMigrateLocal() {
  const p = path.join(ROOT, '.env.migrate.local');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

function escapeSqlString(str) {
  if (str == null) return 'NULL';
  return "'" + String(str).replace(/'/g, "''") + "'";
}

async function main() {
  loadEnvMigrateLocal();
  const dbUrl = process.env.NEON_DATABASE_URL;
  if (!dbUrl) {
    console.error('Set NEON_DATABASE_URL di .env.migrate.local');
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: true },
  });

  const client = await pool.connect();
  const outputFile = path.join(ROOT, 'neon_export.sql');
  const stream = fs.createWriteStream(outputFile);

  try {
    console.log('Mengambil data dari Neon...');
    const result = await client.query(`SELECT ${COLUMNS.join(', ')} FROM sekolah`);
    console.log(`Ditemukan ${result.rows.length} sekolah.`);

    stream.write('-- Export data dari Neon ke D1\n');
    stream.write('BEGIN TRANSACTION;\n');

    for (let i = 0; i < result.rows.length; i++) {
      const row = result.rows[i];
      const values = COLUMNS.map(c => escapeSqlString(row[c]));
      const sql = `INSERT INTO sekolah (${COLUMNS.join(', ')}) VALUES (${values.join(', ')});`;
      stream.write(sql + '\n');
    }

    // Export meta
    const metaResult = await client.query('SELECT key, value FROM sync_meta');
    for (let i = 0; i < metaResult.rows.length; i++) {
      const row = metaResult.rows[i];
      stream.write(`INSERT INTO sync_meta (key, value) VALUES (${escapeSqlString(row.key)}, ${escapeSqlString(row.value)});\n`);
    }

    // Export status
    const statusResult = await client.query('SELECT id, waktu_selesai_terakhir, total_sekolah FROM status_sinkronisasi');
    for (let i = 0; i < statusResult.rows.length; i++) {
      const row = statusResult.rows[i];
      // Convert Date object to ISO string because D1 uses TEXT for timestamps
      let waktuSelesai = 'NULL';
      if (row.waktu_selesai_terakhir) {
        waktuSelesai = escapeSqlString(new Date(row.waktu_selesai_terakhir).toISOString());
      }
      stream.write(`UPDATE status_sinkronisasi SET waktu_selesai_terakhir = ${waktuSelesai}, total_sekolah = ${row.total_sekolah || 'NULL'} WHERE id = ${row.id};\n`);
    }

    // Export page fp
    try {
      const fpResult = await client.query('SELECT page_index, fingerprint FROM sync_page_fp');
      for (let i = 0; i < fpResult.rows.length; i++) {
        const row = fpResult.rows[i];
        stream.write(`INSERT INTO sync_page_fp (page_index, fingerprint) VALUES (${row.page_index}, ${escapeSqlString(row.fingerprint)});\n`);
      }
    } catch {
      console.log('Tabel sync_page_fp belum ada atau kosong.');
    }

    stream.write('COMMIT;\n');
    console.log(`Berhasil mengekspor ke ${outputFile}`);
    console.log('Untuk import ke D1, jalankan:');
    console.log('npx wrangler d1 execute api-sekolah-db --local --file=neon_export.sql');
    console.log('npx wrangler d1 execute api-sekolah-db --remote --file=neon_export.sql');

  } finally {
    stream.end();
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
