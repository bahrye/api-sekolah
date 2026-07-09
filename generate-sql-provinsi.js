import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INPUT_DIR = path.join(__dirname, 'data_provinsi');
const OUTPUT_DIR = path.join(__dirname, 'sql_imports');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR);
}

const batFilePath = path.join(__dirname, 'run_import_provinsi.bat');
let batContent = `@echo off\necho Memulai impor data per provinsi ke D1...\n\n`;

const files = fs.readdirSync(INPUT_DIR).filter(f => f.endsWith('.json'));

let totalSekolah = 0;

for (const file of files) {
  const rawData = fs.readFileSync(path.join(INPUT_DIR, file), 'utf-8');
  const dataProvinsi = JSON.parse(rawData);
  totalSekolah += dataProvinsi.length;

  // Nama file SQL sesuai nama JSON
  const sqlFileName = file.replace('.json', '.sql');
  const sqlFilePath = path.join(OUTPUT_DIR, sqlFileName);

  let sqlContent = `CREATE TABLE IF NOT EXISTS "sekolah" (
	"NPSN" TEXT PRIMARY KEY, "Nama" TEXT, "Bentuk" TEXT, "BentukGroup" TEXT, "Jenis" TEXT,
	"Status" TEXT, "Jenjang" TEXT, "Pembina" TEXT, "Jalur" TEXT, "Kelurahan" TEXT,
	"Kecamatan" TEXT, "Kabupaten" TEXT, "Provinsi" TEXT, "Alamat" TEXT
);\n`;

  for (const row of dataProvinsi) {
    // Escape single quotes by replacing ' with ''
    const safeStr = (str) => {
      if (str === null || str === undefined) return 'NULL';
      return `'${String(str).replace(/'/g, "''")}'`;
    };

    sqlContent += `REPLACE INTO "sekolah" VALUES (${safeStr(row.npsn)}, ${safeStr(row.nama)}, ${safeStr(row.bentukPendidikan)}, ${safeStr(row.bentukPendidikanGroup)}, ${safeStr(row.jenisPendidikan)}, ${safeStr(row.statusSatuanPendidikan)}, ${safeStr(row.jenjangPendidikan)}, ${safeStr(row.pembina)}, ${safeStr(row.jalurPendidikan)}, ${safeStr(row.namaDesa)}, ${safeStr(row.namaKecamatan)}, ${safeStr(row.namaKabupaten)}, ${safeStr(row.namaProvinsi)}, ${safeStr(row.alamatJalan)});\n`;
  }

  fs.writeFileSync(sqlFilePath, sqlContent);

  batContent += `echo Mengimpor ${sqlFileName}...\n`;
  batContent += `call npx wrangler d1 execute api-sekolah-db --remote --file=sql_imports/${sqlFileName}\n`;
  batContent += `if %errorlevel% neq 0 exit /b %errorlevel%\n\n`;
}

batContent += `echo Impor Selesai! Total ${totalSekolah} sekolah diproses.\npause\n`;
fs.writeFileSync(batFilePath, batContent);

console.log(`✅ Berhasil membuat file SQL untuk ${files.length} provinsi.`);
console.log(`🚀 Silakan jalankan 'run_import_provinsi.bat' untuk mengimpor ke D1.`);
