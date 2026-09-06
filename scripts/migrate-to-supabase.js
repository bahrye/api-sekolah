import { DatabaseSync } from 'node:sqlite';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env.supabase
const envPath = path.join(__dirname, '..', '.env.supabase');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Error: SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib diatur di .env.supabase');
  process.exit(1);
}

// Lokasi database SQLite lokal D1
const SQLITE_PATH = path.join(
  __dirname,
  '..',
  '.wrangler',
  'state',
  'v3',
  'd1',
  'miniflare-D1DatabaseObject',
  '4f82089857ba6672bd5ecb9d6e14126cb6bc746122efe41e4f69ac3b7b2aa565.sqlite'
);

if (!fs.existsSync(SQLITE_PATH)) {
  console.error(`❌ Error: File SQLite tidak ditemukan di: ${SQLITE_PATH}`);
  process.exit(1);
}

const PROGRESS_FILE = path.join(__dirname, 'migration-progress.json');

function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    } catch {
      return { lastOffset: 0, completed: false };
    }
  }
  return { lastOffset: 0, completed: false };
}

function saveProgress(offset, completed = false) {
  fs.writeFileSync(
    PROGRESS_FILE,
    JSON.stringify({ lastOffset: offset, completed, updatedAt: new Date().toISOString() }, null, 2)
  );
}

const BATCH_SIZE = 1000; // 1000 baris per batch untuk efisiensi tinggi
const isDryRun = process.argv.includes('--dry-run');
const resetProgress = process.argv.includes('--reset');

async function main() {
  console.log('====================================================');
  console.log('🚀 MIGRASI DATA SEKOLAH KE SUPABASE');
  console.log('====================================================');
  console.log(`📦 Database SQLite: ${path.basename(SQLITE_PATH)}`);
  console.log(`🌐 Supabase Target: ${SUPABASE_URL}`);
  if (isDryRun) console.log('⚠️  DRY RUN MODE AKTIF (Tidak ada data yang dikirim ke Supabase)');
  console.log('----------------------------------------------------');

  const sqlite = new DatabaseSync(SQLITE_PATH);
  const totalRowObj = sqlite.prepare('SELECT count(*) as count FROM sekolah').get();
  const totalRows = Number(totalRowObj.count);
  console.log(`📊 Total data di SQLite lokal: ${totalRows.toLocaleString('id-ID')} baris`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
  });

  // Uji koneksi ke Supabase dan cek tabel sekolah
  if (!isDryRun) {
    const testRes = await supabase.from('sekolah').select('npsn').limit(1);
    if (testRes.error) {
      console.error('\n❌ Gagal terhubung ke tabel `sekolah` di Supabase:');
      console.error(testRes.error.message);
      console.error('\n💡 Solusi:');
      console.error('Buka Dashboard Supabase -> SQL Editor -> Jalankan file `migrations/supabase_schema.sql` terlebih dahulu.');
      process.exit(1);
    }
  }

  let progress = loadProgress();
  if (resetProgress) {
    progress = { lastOffset: 0, completed: false };
    saveProgress(0, false);
    console.log('🔄 Progress di-reset ke 0.');
  }

  let offset = progress.lastOffset || 0;
  if (offset >= totalRows && !resetProgress) {
    console.log('✅ Semua data telah selesai dimigrasikan sebelumnya!');
    console.log('💡 Jika ingin mengulang dari awal, jalankan dengan flag `--reset`.');
    return;
  }

  if (offset > 0) {
    console.log(`⏩ Melanjutkan migrasi dari baris ke-${offset.toLocaleString('id-ID')}...`);
  }

  const queryStmt = sqlite.prepare(`
    SELECT
      npsn, nama, bentuk_pendidikan, bentuk_pendidikan_group, jenis_pendidikan,
      status_satuan_pendidikan, jenjang_pendidikan, pembina, jalur_pendidikan,
      nama_desa, nama_kecamatan, nama_kabupaten, nama_provinsi, alamat_jalan,
      row_fp, migrated_at
    FROM sekolah
    ORDER BY npsn
    LIMIT ? OFFSET ?
  `);

  const startTime = Date.now();
  let uploadedSinceStart = 0;

  while (offset < totalRows) {
    const currentLimit = Math.min(BATCH_SIZE, totalRows - offset);
    const rows = queryStmt.all(currentLimit, offset);

    if (rows.length === 0) break;

    // Bersihkan data jika diperlukan (null handling)
    const payload = rows.map((r) => ({
      npsn: String(r.npsn),
      nama: r.nama || '',
      bentuk_pendidikan: r.bentuk_pendidikan || null,
      bentuk_pendidikan_group: r.bentuk_pendidikan_group || null,
      jenis_pendidikan: r.jenis_pendidikan || null,
      status_satuan_pendidikan: r.status_satuan_pendidikan || null,
      jenjang_pendidikan: r.jenjang_pendidikan || null,
      pembina: r.pembina || null,
      jalur_pendidikan: r.jalur_pendidikan || null,
      nama_desa: r.nama_desa || null,
      nama_kecamatan: r.nama_kecamatan || null,
      nama_kabupaten: r.nama_kabupaten || null,
      nama_provinsi: r.nama_provinsi || null,
      alamat_jalan: r.alamat_jalan || null,
      row_fp: r.row_fp || null,
      migrated_at: r.migrated_at || new Date().toISOString(),
    }));

    if (!isDryRun) {
      let retries = 3;
      let success = false;
      while (retries > 0 && !success) {
        try {
          const { error } = await supabase.from('sekolah').upsert(payload, {
            onConflict: 'npsn',
            ignoreDuplicates: false,
          });

          if (error) throw error;
          success = true;
        } catch (err) {
          retries--;
          console.warn(`\n⚠️ Batch pada offset ${offset} gagal (${err.message}). Mencoba lagi (${retries} sisa)...`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
          if (retries === 0) {
            console.error(`\n❌ Gagal mengirim batch setelah 3 percobaan pada offset ${offset}. Progress tersimpan.`);
            saveProgress(offset, false);
            process.exit(1);
          }
        }
      }
    }

    offset += rows.length;
    uploadedSinceStart += rows.length;
    saveProgress(offset, offset >= totalRows);

    // Hitung kecepatan & estimasi waktu sisa (ETA)
    const elapsedSec = (Date.now() - startTime) / 1000;
    const rate = Math.round(uploadedSinceStart / (elapsedSec || 1));
    const remainingRows = totalRows - offset;
    const etaSec = rate > 0 ? Math.round(remainingRows / rate) : 0;
    const etaMin = (etaSec / 60).toFixed(1);
    const percent = ((offset / totalRows) * 100).toFixed(2);

    process.stdout.write(
      `\r⏳ [${offset.toLocaleString('id-ID')} / ${totalRows.toLocaleString('id-ID')}] (${percent}%) | Kecepatan: ${rate} baris/dtk | ETA: ~${etaMin} mnt   `
    );
  }

  console.log('\n----------------------------------------------------');
  console.log('🎉 MIGRASI SELESAI DENGAN SUKSES!');
  console.log(`✅ Total baris berhasil diproses: ${totalRows.toLocaleString('id-ID')}`);
  console.log('====================================================');
}

main().catch((err) => {
  console.error('\n❌ Fatal Error:', err);
  process.exit(1);
});
