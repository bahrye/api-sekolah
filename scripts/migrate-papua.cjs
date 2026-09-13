const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.supabase' });

const SQLITE_PATH = path.join(
  __dirname,
  '..',
  '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject',
  '4f82089857ba6672bd5ecb9d6e14126cb6bc746122efe41e4f69ac3b7b2aa565.sqlite'
);

const sqlite = new DatabaseSync(SQLITE_PATH);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const PAPUA_PROVINCES = [
  'PROV. PAPUA BARAT',
  'PROV. PAPUA BARAT DAYA',
  'PROV. PAPUA PEGUNUNGAN',
  'PROV. PAPUA SELATAN',
  'PROV. PAPUA TENGAH'
];

async function runMigration() {
  console.log('🚀 Memulai migrasi data sekolah untuk 5 provinsi Papua dari SQLite ke Supabase...');
  
  let grandTotal = 0;
  for (const prov of PAPUA_PROVINCES) {
    const totalRow = sqlite.prepare('SELECT count(*) as count FROM sekolah WHERE nama_provinsi = ?').get(prov);
    const count = Number(totalRow.count);
    console.log(`\n📍 Memproses ${prov} (${count} sekolah)...`);
    
    let offset = 0;
    const batchSize = 500;
    while (offset < count) {
      const rows = sqlite.prepare('SELECT * FROM sekolah WHERE nama_provinsi = ? LIMIT ? OFFSET ?').all(prov, batchSize, offset);
      if (rows.length === 0) break;
      
      const payload = rows.map(r => ({
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
        migrated_at: new Date().toISOString()
      }));
      
      let retries = 3;
      while (retries > 0) {
        const { error } = await supabase.from('sekolah').upsert(payload, { onConflict: 'npsn' });
        if (!error) break;
        retries--;
        console.warn(`Retry batch ${offset}... (${error.message})`);
        await new Promise(r => setTimeout(r, 1500));
        if (retries === 0) throw error;
      }
      
      offset += rows.length;
      grandTotal += rows.length;
      process.stdout.write(`\r   Progress ${prov}: ${offset} / ${count}`);
    }
    console.log(`\n✅ Selesai ${prov}`);
  }
  
  console.log(`\n🎉 Berhasil memigrasikan total ${grandTotal} sekolah ke Supabase!`);
  
  // Hitung ulang total sekolah di Supabase
  const { count: finalCount } = await supabase.from('sekolah').select('*', { count: 'exact', head: true });
  console.log(`📊 Total sekolah aktual di Supabase sekarang: ${finalCount}`);
  
  // Update status_sinkronisasi
  await supabase.from('status_sinkronisasi').update({
    total_sekolah: finalCount,
    updated_at: new Date().toISOString()
  }).in('id', [1, 2]);
  console.log('✅ status_sinkronisasi berhasil diperbarui.');
}

runMigration().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
