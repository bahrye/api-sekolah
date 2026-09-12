import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { getDataSourceUrl } from './functions/lib/source-config.js';

dotenv.config();
const API_BASE = getDataSourceUrl(process.env);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_DIR = path.join(__dirname, 'data_provinsi');
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR);
}

async function jalankanAutomasi() {
  console.log("🚀 Memulai proses unduh data sekolah per provinsi...");

  let totalKeseluruhan = 0;

  for (let i = 1; i <= 40; i++) {
    const kode = i.toString().padStart(2, '0') + '0000';
    const limit = 20; 
    
    try {
      // Cek apakah kode wilayah ini valid (ada datanya)
      const testUrl = `${API_BASE}/360?limit=1&offset=0&kodeWilayah=${kode}`;
      const testRes = await fetch(testUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
      const testJson = await testRes.json();
      
      const totalProvinsi = testJson.meta?.total || 0;
      const namaProvinsi = testJson.meta?.kodeWilayah || `Provinsi_${kode}`;

      if (totalProvinsi === 0) {
        // Kode wilayah tidak valid / tidak ada data
        continue;
      }

      console.log(`\n📌 Ditemukan: ${namaProvinsi} (${kode}) dengan ${totalProvinsi} sekolah.`);
      
      const fileOutput = path.join(OUTPUT_DIR, `data_${kode}_${namaProvinsi.replace(/[^a-zA-Z0-9]/g, '_')}.json`);
      
      // Jika file sudah ada dan jumlahnya sama, bisa kita skip (Resume feature)
      if (fs.existsSync(fileOutput)) {
        const existingData = JSON.parse(fs.readFileSync(fileOutput, 'utf-8'));
        if (existingData.length >= totalProvinsi) {
            console.log(`✅ Data ${namaProvinsi} sudah lengkap, melewati...`);
            totalKeseluruhan += existingData.length;
            continue;
        } else {
            console.log(`⚠️ Data ${namaProvinsi} belum lengkap (${existingData.length}/${totalProvinsi}), mengulang unduhan...`);
        }
      }

      let offset = 0;
      let dataProvinsi = [];
      let running = true;

      while (running) {
        if (offset >= totalProvinsi) {
          break;
        }

        const url = `${API_BASE}/360?limit=${limit}&offset=${offset}&kodeWilayah=${kode}`;
        
        try {
          const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
          });
          
          if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
          
          const json = await response.json();
          const dataMataIni = json.data?.rows || json.data || [];

          if (dataMataIni.length === 0) {
            running = false;
            break;
          }

          dataProvinsi.push(...dataMataIni);
          process.stdout.write(`\r   Mengunduh... ${dataProvinsi.length} / ${totalProvinsi} sekolah`);

          offset += limit;

          // Jeda agar tidak terkena rate-limit
          await new Promise(res => setTimeout(res, 100));

        } catch (err) {
          if (err.message.includes('404') && offset >= totalProvinsi) {
              // Jika 404 di akhir data, anggap selesai
              break;
          }
          console.error(`\n❌ Gagal di offset ${offset} (${namaProvinsi}):`, err.message);
          console.log("Mencoba ulang dalam 3 detik...");
          await new Promise(res => setTimeout(res, 3000));
        }
      }

      console.log(`\n💾 Menyimpan ${dataProvinsi.length} data ke file...`);
      fs.writeFileSync(fileOutput, JSON.stringify(dataProvinsi, null, 2));
      totalKeseluruhan += dataProvinsi.length;

    } catch (e) {
      console.error(`Gagal mengecek provinsi ${kode}:`, e.message);
    }
  }

  console.log(`\n🎉 SELESAI! Total keseluruhan data yang diunduh: ${totalKeseluruhan}`);
  console.log(`📂 Semua file JSON tersimpan di folder: ${OUTPUT_DIR}`);
}

jalankanAutomasi();
