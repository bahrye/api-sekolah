import { getDataSourceUrl } from '../lib/source-config.js';

export async function onRequest(context) {
    const { searchParams } = new URL(context.request.url);
    // Ambil data start dari URL, kalau tidak ada mulai dari 0
    let offset = parseInt(searchParams.get('start')) || 0; 
    
    const limitPusat = 20; // Tetap gunakan limit 20
    let semuaData = [];
  
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    };
  
    try {
      // 1. Ambil data lama yang sudah tersimpan di KV
      const dataLamaRaw = await context.env.DATA_SEKOLAH_KV?.get?.("list_sekolah");
      if (dataLamaRaw) {
        semuaData = JSON.parse(dataLamaRaw);
      }
  
      // 2. Hanya lakukan SATU kali fetch ke pusat (0 looping)
      const apiBase = getDataSourceUrl(context.env);
      const targetUrl = `${apiBase}/360?limit=${limitPusat}&offset=${offset}`;
      
      const response = await fetch(targetUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 CloudflarePagesFetch' }
      });
      
      if (!response.ok) throw new Error(`Server pusat menolak request pada offset ${offset}`);
      
      const jsonResult = await response.json();
      const dataMataIni = jsonResult.data?.rows || jsonResult.data || [];
  
      // Jika data yang didapat kosong, berarti database di pusat sudah habis
      if (dataMataIni.length === 0) {
        return new Response(JSON.stringify({ 
          status: "success", 
          message: `Proses selesai! Semua data telah berhasil ditarik. Total akhir: ${semuaData.length} sekolah.`,
          is_finished: true
        }), { headers });
      }
  
      // 3. Masukkan data baru ke dalam array utama (hindari duplikat)
      dataMataIni.forEach(sekolahBaru => {
        if (!semuaData.some(sekolahLama => sekolahLama.npsn === sekolahBaru.npsn)) {
          semuaData.push(sekolahBaru);
        }
      });
  
      // 4. Simpan kembali total data terbaru ke KV
      await context.env.DATA_SEKOLAH_KV.put("list_sekolah", JSON.stringify(semuaData));
  
      // Hitung offset berikutnya
      const nextOffset = offset + limitPusat;
      const currentUrl = new URL(context.request.url);
      const nextUrl = `${currentUrl.origin}${currentUrl.pathname}?start=${nextOffset}`;
  
      // 5. Berikan respon balik berupa data link kelanjutan
      return new Response(JSON.stringify({ 
        status: "success", 
        message: `Berhasil menyimpan data urutan ${offset} sampai ${nextOffset - 1}.`,
        total_sekarang_di_database: semuaData.length,
        is_finished: false,
        next_offset: nextOffset,
        klik_link_ini_untuk_lanjut: nextUrl // Anda tinggal klik link ini di browser untuk lanjut mencicil
      }), { headers });
  
    } catch (error) {
      return new Response(JSON.stringify({ status: "error", message: error.message }), { status: 500, headers });
    }
  }