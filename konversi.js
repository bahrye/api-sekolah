const fs = require('fs');
const readline = require('readline');

async function csvToJson() {
  const csvFilePath = 'data_sekolah.csv'; // Sesuaikan dengan nama file CSV Anda
  const jsonFilePath = 'data_sekolah_lengkap.json';

  const fileStream = fs.createReadStream(csvFilePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let headers = [];
  let isFirstLine = true;
  
  // Menggunakan Write Stream agar hemat memori RAM
  const jsonStream = fs.createWriteStream(jsonFilePath);
  jsonStream.write('[\n');

  let isFirstRow = true;

  console.log("⏳ Memulai konversi... Mohon tunggu.");

  for await (const line of rl) {
    // Memisahkan kolom berdasarkan koma (sesuaikan jika CSV Anda menggunakan titik koma ';')
    const row = line.split(','); 

    if (isFirstLine) {
      // Mengambil baris pertama sebagai nama kolom/property JSON
      headers = row.map(h => h.trim().replace(/"/g, ''));
      isFirstLine = false;
      continue;
    }

    if (row.length === headers.length) {
      const obj = {};
      headers.forEach((header, index) => {
        obj[header] = row[index].trim().replace(/"/g, '');
      });

      if (!isFirstRow) {
        jsonStream.write(',\n');
      }
      jsonStream.write(JSON.stringify(obj));
      isFirstRow = false;
    }
  }

  jsonStream.write('\n]');
  jsonStream.end();
  console.log('✅ Konversi CSV ke JSON Selesai dalam hitungan detik!');
}

csvToJson();