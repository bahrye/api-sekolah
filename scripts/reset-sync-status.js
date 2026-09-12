import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';

// Muat env dari .env.supabase atau .env
if (fs.existsSync('.env.supabase')) {
  dotenv.config({ path: '.env.supabase' });
} else {
  dotenv.config();
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ SUPABASE_URL atau SUPABASE_SERVICE_ROLE_KEY tidak ditemukan.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function resetSyncStatus() {
  console.log('🔄 Mereset status sinkronisasi di Supabase...');

  const now = new Date().toISOString();
  const resetData = {
    bentuk_aktif: 'Selesai',
    offset_terakhir: 0,
    total_baru: 0,
    total_diperbarui: 0,
    total_tidak_berubah: 0,
    total_tanpa_npsn: 0,
    total_estimasi: 0,
    updated_at: now,
    waktu_selesai_terakhir: now
  };

  const { error: err2 } = await supabase
    .from('status_sinkronisasi')
    .update(resetData)
    .eq('id', 2);

  if (err2) {
    console.error('❌ Gagal mereset status ID 2:', err2.message);
  } else {
    console.log('✅ Status Custom Sync (ID 2) berhasil direset ke [Selesai / Kosong].');
  }

  const { error: err1 } = await supabase
    .from('status_sinkronisasi')
    .update({
      bentuk_aktif: 'tk',
      offset_terakhir: 0,
      total_baru: 0,
      total_diperbarui: 0,
      total_tidak_berubah: 0,
      total_tanpa_npsn: 0,
      updated_at: now
    })
    .eq('id', 1);

  if (err1) {
    console.error('❌ Gagal mereset status ID 1:', err1.message);
  } else {
    console.log('✅ Status Full Sync (ID 1) berhasil direset.');
  }

  console.log('🎉 Dashboard sekarang sudah kembali bersih dan tidak stuck.');
}

resetSyncStatus();
