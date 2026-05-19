const fs = require('fs');
const readline = require('readline');

const inputPath = 'data.sql';
const outputPath = 'data.sql.new';

const createTable = `CREATE TABLE IF NOT EXISTS "sekolah" (
	"NPSN"	TEXT PRIMARY KEY,
	"Nama"	TEXT,
	"Bentuk"	TEXT,
	"BentukGroup"	TEXT,
	"Jenis"	TEXT,
	"Status"	TEXT,
	"Jenjang"	TEXT,
	"Pembina"	TEXT,
	"Jalur"	TEXT,
	"Kelurahan"	TEXT,
	"Kecamatan"	TEXT,
	"Kabupaten"	TEXT,
	"Provinsi"	TEXT,
	"Alamat"	TEXT
);
`;

async function main() {
  const seen = new Set();
  let total = 0;
  let skipped = 0;
  let written = 0;

  const out = fs.createWriteStream(outputPath);
  out.write(createTable);

  const rl = readline.createInterface({
    input: fs.createReadStream(inputPath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const m = line.match(/^INSERT INTO "sekolah" VALUES \('([^']+)'/);
    if (!m) continue;

    total++;
    const npsn = m[1];
    if (seen.has(npsn)) {
      skipped++;
      continue;
    }
    seen.add(npsn);
    out.write(line + '\n');
    written++;
  }

  await new Promise((resolve, reject) => {
    out.end((err) => (err ? reject(err) : resolve()));
  });

  console.log(JSON.stringify({ total, written, skipped, unique: seen.size }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
