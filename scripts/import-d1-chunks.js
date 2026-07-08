import fs from 'fs';
import readline from 'readline';
import { spawn } from 'child_process';
import path from 'path';

const CHUNK_SIZE_LINES = 20000;
const inputFile = 'neon_export.sql';

async function runWrangler(file, attempt = 1) {
  return new Promise((resolve, reject) => {
    console.log(`Mengunggah ${file} (Percobaan ${attempt})...`);
    const proc = spawn(/^win/.test(process.platform) ? 'npx.cmd' : 'npx', [
      'wrangler', 'd1', 'execute', 'api-sekolah-db', '--remote', `--file=${file}`
    ], { stdio: 'inherit', shell: true });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else {
        if (attempt < 3) {
          console.log(`Gagal, mengulang unggahan ${file}...`);
          resolve(runWrangler(file, attempt + 1));
        } else {
          reject(new Error(`Wrangler gagal mengeksekusi ${file} dengan exit code ${code}`));
        }
      }
    });
  });
}

async function main() {
  const fileStream = fs.createReadStream(inputFile);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let lines = [];
  let chunkIndex = 1;

  for await (const line of rl) {
    if (line.trim().toUpperCase() === 'BEGIN TRANSACTION;' || line.trim().toUpperCase() === 'COMMIT;') {
      continue; // Skip explicit transactions as D1 HTTP doesn't support them
    }
    lines.push(line);
    if (lines.length >= CHUNK_SIZE_LINES) {
      const chunkFile = `chunk_${chunkIndex}.sql`;
      fs.writeFileSync(chunkFile, lines.join('\n'));
      await runWrangler(chunkFile);
      fs.unlinkSync(chunkFile);
      lines = [];
      chunkIndex++;
    }
  }

  if (lines.length > 0) {
    const chunkFile = `chunk_${chunkIndex}.sql`;
    fs.writeFileSync(chunkFile, lines.join('\n'));
    await runWrangler(chunkFile);
    fs.unlinkSync(chunkFile);
  }

  console.log('Semua chunk berhasil diunggah ke D1!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
