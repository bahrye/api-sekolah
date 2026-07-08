import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import csv from 'csv-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CSV_FILE = path.join(__dirname, '../DATA_SEKOLAH.csv');
const OUT_DIR = path.join(__dirname, '../sql_imports');

if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

const BATCH_SIZE = 2500;
let fileIndex = 1;
let currentBatch = [];
let totalRows = 0;

function escapeSql(str) {
  if (str === null || str === undefined) return 'NULL';
  return `'${String(str).replace(/'/g, "''")}'`;
}

function flushBatch() {
  if (currentBatch.length === 0) return;

  const fileName = `import_${String(fileIndex).padStart(3, '0')}.sql`;
  const filePath = path.join(OUT_DIR, fileName);

  let sql = `-- Batch ${fileIndex} - ${currentBatch.length} rows\n`;

  for (const row of currentBatch) {
    sql += `INSERT INTO sekolah (npsn, nama, bentuk_pendidikan, jenis_pendidikan, status_satuan_pendidikan, jenjang_pendidikan, nama_kabupaten, nama_kecamatan, nama_desa, alamat_jalan, jalur_pendidikan, pembina)\n`;
    sql += `VALUES (${escapeSql(row.NPSN)}, ${escapeSql(row.Nama)}, ${escapeSql(row.Bentuk)}, ${escapeSql(row.Jenis)}, ${escapeSql(row.Status)}, ${escapeSql(row.Jenjang)}, ${escapeSql(row.Kabupaten)}, ${escapeSql(row.Kecamatan)}, ${escapeSql(row.Kelurahan)}, ${escapeSql(row.Alamat)}, ${escapeSql(row.Jalur)}, ${escapeSql(row.Pembina)})\n`;
    sql += `ON CONFLICT (npsn) DO UPDATE SET
      nama=excluded.nama,
      bentuk_pendidikan=excluded.bentuk_pendidikan,
      jenis_pendidikan=excluded.jenis_pendidikan,
      status_satuan_pendidikan=excluded.status_satuan_pendidikan,
      jenjang_pendidikan=excluded.jenjang_pendidikan,
      nama_kabupaten=excluded.nama_kabupaten,
      nama_kecamatan=excluded.nama_kecamatan,
      nama_desa=excluded.nama_desa,
      alamat_jalan=excluded.alamat_jalan,
      jalur_pendidikan=excluded.jalur_pendidikan,
      pembina=excluded.pembina;\n`;
  }

  fs.writeFileSync(filePath, sql);
  console.log(`Berhasil membuat ${fileName} (${currentBatch.length} baris)`);

  fileIndex++;
  currentBatch = [];
}

console.log('Mulai membaca file CSV...');

fs.createReadStream(CSV_FILE)
  .pipe(csv({ skipLines: 1 }))
  .on('data', (data) => {
    // Pastikan NPSN ada
    if (!data.NPSN) return;
    
    currentBatch.push(data);
    totalRows++;

    if (currentBatch.length >= BATCH_SIZE) {
      flushBatch();
    }
  })
  .on('end', () => {
    flushBatch();
    console.log(`Selesai! Total ${totalRows} baris sekolah dikonversi menjadi ${fileIndex - 1} file SQL.`);
    
    // Generate script batch
    const batPath = path.join(__dirname, '../run_import.bat');
    let batContent = `@echo off\necho Memulai impor CSV ke D1...\n\n`;
    for (let i = 1; i < fileIndex; i++) {
      const fileName = `import_${String(i).padStart(3, '0')}.sql`;
      batContent += `echo Mengimpor ${fileName}...\n`;
      batContent += `call npx wrangler d1 execute api-sekolah-db --remote --file=sql_imports/${fileName}\n`;
      batContent += `if %errorlevel% neq 0 exit /b %errorlevel%\n\n`;
    }
    batContent += `echo Impor Selesai!\npause`;
    fs.writeFileSync(batPath, batContent);
    console.log(`Script eksekusi massal dibuat di run_import.bat`);
  });
