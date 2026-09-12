import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPath = path.join(__dirname, '..', '.env.supabase');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });
else dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const rekapPath = path.join(__dirname, '..', 'data_rekap.json');
const rekap = JSON.parse(fs.readFileSync(rekapPath, 'utf8'));

const diffProvs = [
  'PROV. ACEH', 'PROV. BALI', 'PROV. BANTEN', 'PROV. D.I. YOGYAKARTA',
  'PROV. D.K.I. JAKARTA', 'PROV. JAMBI', 'PROV. JAWA BARAT', 'PROV. JAWA TIMUR',
  'PROV. LAMPUNG', 'PROV. RIAU', 'PROV. SULAWESI UTARA', 'PROV. SUMATERA SELATAN'
];

async function updateAll() {
  console.log('🔄 Memulai pembaruan data_rekap.json dari database Supabase...');
  const startTime = Date.now();

  // 1. Ambil v_rekap_provinsi untuk perbandingan target
  const { data: vRekap } = await supabase.from('v_rekap_provinsi').select('*');
  const vMap = new Map((vRekap || []).map(r => [r.nama_provinsi, r.total_sekolah]));

  // Ambil semua daftar bentuk pendidikan yang dikenal di metadata
  if (!rekap.metadata.jenjang.includes('SEKOLAH NASIONAL TERINTEGRASI')) {
    rekap.metadata.jenjang.push('SEKOLAH NASIONAL TERINTEGRASI');
    rekap.metadata.jenjang.sort();
  }
  const allKnownShapes = rekap.metadata?.jenjang || [];

  for (const prov of diffProvs) {
    const targetTotal = vMap.get(prov) || 0;
    const currentShapes = rekap.data.indonesia[prov] || {};
    
    // Gabungkan bentuk yang sudah ada di prov dengan semua jenjang dikenal
    const shapeSet = new Set([...Object.keys(currentShapes), ...allKnownShapes]);
    const shapeList = Array.from(shapeSet);

    // Jalankan penghitungan paralel untuk seluruh bentuk pendidikan di provinsi ini
    const counts = await Promise.all(shapeList.map(async (shape) => {
      try {
        const { count, error } = await supabase.from('sekolah')
          .select('*', { count: 'exact', head: true })
          .eq('nama_provinsi', prov)
          .eq('bentuk_pendidikan', shape);
        return { shape, count: (!error && count !== null) ? count : 0 };
      } catch (e) {
        return { shape, count: 0 };
      }
    }));

    let provTotal = 0;
    const newShapes = {};
    for (const item of counts) {
      if (item.count > 0) {
        newShapes[item.shape] = item.count;
        provTotal += item.count;
      }
    }

    rekap.data.indonesia[prov] = newShapes;
    console.log(`✅ ${prov}: target DB = ${targetTotal}, hasil bentuk = ${provTotal} (selisih: ${targetTotal - provTotal})`);
  }

  // Simpan hasil ke data_rekap.json
  fs.writeFileSync(rekapPath, JSON.stringify(rekap, null, 2), 'utf8');
  console.log(`💾 Berhasil menyimpan data terbaru ke data_rekap.json dalam ${((Date.now() - startTime) / 1000).toFixed(1)}s!`);
}

updateAll().catch(err => console.error('Error updating rekap:', err));
