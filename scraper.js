const fs = require('fs');

async function jalankanAutomasi() {
  let offset = 0;
  const limit = 20;
  let running = true;
  let semuaData = [];

  console.log("🚀 Memulai proses unduh 550.000 data sekolah...");

  while (running) {
    try {
      const url = `https://api.data.belajar.id/data-portal-backend/v2/master-data/satuan-pendidikan/daftar-data-induk/360?limit=${limit}&offset=${offset}`;
      
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      
      if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
      
      const json = await response.json();
      const dataMataIni = json.data?.rows || json.data || [];

      if (dataMataIni.length === 0) {
        console.log("🎉 Selesai! Ujung database telah tercapai.");
        break;
      }

      // Masukkan ke penampung utama
      semuaData.push(...dataMataIni);
      console.log(`Berhasil mengunduh data ${offset} s/d ${offset + dataMataIni.length - 1} | Total terkumpul: ${semuaData.length}`);

      offset += limit;

      // Beri jeda 150 milidetik agar IP Anda tidak di-banned karena dianggap melakukan serangan DDoS
      await new Promise(res => setTimeout(res, 150));

    } catch (err) {
      console.error(`❌ Gagal di offset ${offset}:`, err.message);
      console.log("Mencoba ulang dalam 5 detik...");
      await new Promise(res => setTimeout(res, 5000));
    }
  }

  // Setelah semua perulangan selesai, simpan hasilnya ke dalam file lokal
  console.log("Menyimpan data ke file data_sekolah_lengkap.json...");
  fs.writeFileSync('data_sekolah_lengkap.json', JSON.stringify(semuaData, null, 2));
  console.log("✅ File berhasil dibuat!");
}

jalankanAutomasi();