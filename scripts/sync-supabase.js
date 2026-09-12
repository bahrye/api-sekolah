import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { getDataSourceUrl } from '../functions/lib/source-config.js';

const API_BASE = getDataSourceUrl(process.env);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPath = path.join(__dirname, '..', '.env.supabase');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
else dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Error: SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib diatur di .env.supabase');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const BATCH_SIZE = 500;
const FETCH_LIMIT = 100;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function syncProvinsi(kode, namaProvinsi, total) {
  console.log(`\n🔄 Menyinkronkan ${namaProvinsi} (Total: ${total.toLocaleString('id-ID')} sekolah)...`);
  let offset = 0;
  let batchBuffer = [];
  let synced = 0;

  while (offset < total) {
    const url = `${API_BASE}/360?limit=${FETCH_LIMIT}&offset=${offset}&kodeWilayah=${kode}`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const json = await res.json();
      const rows = json?.data || [];

      if (rows.length === 0) break;

      for (const r of rows) {
        batchBuffer.push({
          npsn: String(r.npsn),
          nama: r.nama || '',
          bentuk_pendidikan: r.bentukPendidikan || null,
          bentuk_pendidikan_group: r.bentukPendidikanGroup || null,
          jenis_pendidikan: r.jenisPendidikan || null,
          status_satuan_pendidikan: r.statusSatuanPendidikan || null,
          jenjang_pendidikan: r.jenjangPendidikan || null,
          pembina: r.pembina || null,
          jalur_pendidikan: r.jalurPendidikan || null,
          nama_desa: r.namaDesa || null,
          nama_kecamatan: r.namaKecamatan || null,
          nama_kabupaten: r.namaKabupaten || null,
          nama_provinsi: r.namaProvinsi || namaProvinsi,
          alamat_jalan: r.alamatJalan || null,
          migrated_at: new Date().toISOString(),
        });

        if (batchBuffer.length >= BATCH_SIZE) {
          const { error } = await supabase.from('sekolah').upsert(batchBuffer, { onConflict: 'npsn' });
          if (error) console.error('Upsert batch error:', error.message);
          synced += batchBuffer.length;
          batchBuffer = [];
          process.stdout.write(`\r  Progress ${namaProvinsi}: ${synced} / ${total}`);
        }
      }

      offset += rows.length;
      await sleep(100);
    } catch (err) {
      console.error(`\nFetch error at offset ${offset}:`, err.message);
      await sleep(1500);
    }
  }

  if (batchBuffer.length > 0) {
    const { error } = await supabase.from('sekolah').upsert(batchBuffer, { onConflict: 'npsn' });
    if (error) console.error('Final upsert error:', error.message);
    synced += batchBuffer.length;
  }

  console.log(`\n✅ Selesai ${namaProvinsi}: ${synced} sekolah disinkronkan.`);
}

async function main() {
  console.log('🚀 Memulai Sync Langsung ke Supabase...');
  for (let i = 1; i <= 40; i++) {
    const kode = i.toString().padStart(2, '0') + '0000';
    try {
      const testUrl = `${API_BASE}/360?limit=1&offset=0&kodeWilayah=${kode}`;
      const testRes = await fetch(testUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const testJson = await testRes.json();
      const total = testJson.meta?.total || 0;
      const nama = testJson.meta?.kodeWilayah || `Provinsi_${kode}`;

      if (total > 0) {
        await syncProvinsi(kode, nama, total);
      }
    } catch (e) {
      console.error(`Error checking wilayah ${kode}:`, e.message);
    }
  }

  // Update status sinkronisasi
  const countRes = await supabase.from('sekolah').select('*', { count: 'exact', head: true });
  await supabase.from('status_sinkronisasi').upsert({
    id: 1,
    waktu_selesai_terakhir: new Date().toISOString(),
    total_sekolah: countRes.count,
    updated_at: new Date().toISOString(),
  });
  console.log('🎉 Sinkronisasi penuh ke Supabase selesai!');
}

main().catch(console.error);
