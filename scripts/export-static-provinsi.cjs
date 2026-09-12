/**
 * Skrip untuk mengekspor data sekolah dari database Supabase ke file Static JSON
 * terpartisi per provinsi di folder data_provinsi/
 *
 * Penggunaan:
 *   node scripts/export-static-provinsi.cjs           # Ekspor seluruh provinsi
 *   node scripts/export-static-provinsi.cjs --sample  # Ekspor 2 provinsi kecil untuk testing cepat
 *   node scripts/export-static-provinsi.cjs --prov="PROV. GORONTALO" # Ekspor provinsi tertentu
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

// Load environment variables (.env.supabase, .dev.vars, atau .env)
const envFiles = ['.env.supabase', '.dev.vars', '.env'];
for (const file of envFiles) {
  const p = path.join(__dirname, '..', file);
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL atau SUPABASE_SERVICE_ROLE_KEY / SUPABASE_KEY belum dikonfigurasi.');
  console.error('   👉 Jika dijalankan di GitHub Actions, tambahkan Secrets di Settings -> Secrets and variables -> Actions:');
  console.error('      - SUPABASE_URL');
  console.error('      - SUPABASE_SERVICE_ROLE_KEY (atau SUPABASE_KEY / SUPABASE_ANON_KEY)');
  console.error('   👉 Jika dijalankan lokal, pastikan file .env.supabase atau .env sudah terisi.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const OUTPUT_DIR = path.join(__dirname, '..', 'data_provinsi');
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function getSlug(name) {
  return (name || '')
    .toLowerCase()
    .replace(/^provinsi\s+|^prov\.\s+|^prov\s+/i, '')
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function formatSchoolRow(r) {
  return {
    npsn: r.npsn,
    nama: r.nama || '',
    bentuk_pendidikan: r.bentuk_pendidikan || null,
    bentuk_pendidikan_group: r.bentuk_pendidikan_group || null,
    jenis_pendidikan: r.jenis_pendidikan || null,
    status_satuan_pendidikan: r.status_satuan_pendidikan || null,
    jenjang_pendidikan: r.jenjang_pendidikan || null,
    pembina: r.pembina ? r.pembina.replace(/;/g, '') : null,
    jalur_pendidikan: r.jalur_pendidikan || null,
    nama_desa: r.nama_desa || null,
    nama_kecamatan: r.nama_kecamatan || null,
    nama_kabupaten: r.nama_kabupaten || null,
    nama_provinsi: r.nama_provinsi || null,
    alamat_jalan: r.alamat_jalan || null,
    satuan_pendidikan_id: r.satuan_pendidikan_id || null,
    kode_wilayah: r.kode_wilayah || null,
  };
}

async function fetchSchoolsForProvince(provName, expectedTotal = 0) {
  const batchSize = 1000;
  let offset = 0;
  const rows = [];

  while (true) {
    const { data, error } = await supabase
      .from('sekolah')
      .select('npsn, nama, bentuk_pendidikan, bentuk_pendidikan_group, jenis_pendidikan, status_satuan_pendidikan, jenjang_pendidikan, pembina, jalur_pendidikan, nama_desa, nama_kecamatan, nama_kabupaten, nama_provinsi, alamat_jalan')
      .eq('nama_provinsi', provName)
      .order('npsn', { ascending: true })
      .range(offset, offset + batchSize - 1);

    if (error) {
      throw new Error(`Gagal mengambil data ${provName} di offset ${offset}: ${error.message}`);
    }

    if (!data || data.length === 0) break;

    rows.push(...data.map(formatSchoolRow));
    process.stdout.write(`\r   Mengambil... ${rows.length}${expectedTotal ? ` / ${expectedTotal}` : ''} baris`);

    if (data.length < batchSize) break;
    offset += batchSize;
  }

  return rows;
}

const DAFTAR_PROVINSI_DEFAULT = [
  { nama: 'LUAR NEGERI', total: 221 },
  { nama: 'PROV. ACEH', total: 13871 },
  { nama: 'PROV. BALI', total: 6092 },
  { nama: 'PROV. BANTEN', total: 20586 },
  { nama: 'PROV. BENGKULU', total: 4958 },
  { nama: 'PROV. D.I. YOGYAKARTA', total: 8646 },
  { nama: 'PROV. D.K.I. JAKARTA', total: 11585 },
  { nama: 'PROV. GORONTALO', total: 3352 },
  { nama: 'PROV. JAMBI', total: 9246 },
  { nama: 'PROV. JAWA BARAT', total: 85424 },
  { nama: 'PROV. JAWA TENGAH', total: 67113 },
  { nama: 'PROV. JAWA TIMUR', total: 91670 },
  { nama: 'PROV. KALIMANTAN BARAT', total: 11697 },
  { nama: 'PROV. KALIMANTAN SELATAN', total: 10304 },
  { nama: 'PROV. KALIMANTAN TENGAH', total: 8091 },
  { nama: 'PROV. KALIMANTAN TIMUR', total: 7024 },
  { nama: 'PROV. KALIMANTAN UTARA', total: 1690 },
  { nama: 'PROV. KEPULAUAN BANGKA BELITUNG', total: 2438 },
  { nama: 'PROV. KEPULAUAN RIAU', total: 3690 },
  { nama: 'PROV. LAMPUNG', total: 16594 },
  { nama: 'PROV. MALUKU', total: 5781 },
  { nama: 'PROV. MALUKU UTARA', total: 4640 },
  { nama: 'PROV. NUSA TENGGARA BARAT', total: 14835 },
  { nama: 'PROV. NUSA TENGGARA TIMUR', total: 15219 },
  { nama: 'PROV. PAPUA', total: 2329 },
  { nama: 'PROV. RIAU', total: 13849 },
  { nama: 'PROV. SULAWESI BARAT', total: 4456 },
  { nama: 'PROV. SULAWESI SELATAN', total: 19964 },
  { nama: 'PROV. SULAWESI TENGAH', total: 9046 },
  { nama: 'PROV. SULAWESI TENGGARA', total: 7787 },
  { nama: 'PROV. SULAWESI UTARA', total: 6779 },
  { nama: 'PROV. SUMATERA BARAT', total: 12560 },
  { nama: 'PROV. SUMATERA SELATAN', total: 15801 },
  { nama: 'PROV. SUMATERA UTARA', total: 30504 }
];

async function run() {
  console.log('🚀 Memulai ekspor data sekolah ke Static JSON...');
  const t0 = Date.now();

  const args = process.argv.slice(2);
  const isSample = args.includes('--sample');
  const provArg = args.find(a => a.startsWith('--prov='))?.split('=')[1];

  // 1. Ambil daftar provinsi & hitungan total sekolah secara cepat tanpa scan berat
  const provMapCount = new Map();
  try {
    const { data: statusRows } = await supabase
      .from('provinsi_sync_status')
      .select('nama_provinsi, total_db');
    if (statusRows && statusRows.length > 0) {
      for (const s of statusRows) {
        const clean = (s.nama_provinsi || '').toUpperCase().replace(/^(PROVINSI|PROV\.?)\s*/i, '').trim();
        provMapCount.set(clean, s.total_db || 0);
      }
    }
  } catch (e) {
    // Fallback aman jika tabel status belum siap
  }

  const provList = DAFTAR_PROVINSI_DEFAULT.map(p => {
    const clean = p.nama.toUpperCase().replace(/^(PROVINSI|PROV\.?)\s*/i, '').trim();
    return {
      nama_provinsi: p.nama,
      total_sekolah: provMapCount.get(clean) || p.total
    };
  });

  let targetProvinces = provList;

  if (provArg) {
    targetProvinces = provList.filter(p =>
      p.nama_provinsi.toLowerCase().includes(provArg.toLowerCase())
    );
    // Jika tidak cocok dengan nama standar, buat entri langsung dari argumen
    if (targetProvinces.length === 0) {
      targetProvinces = [{ nama_provinsi: provArg, total_sekolah: 0 }];
    }
    console.log(`🎯 Memfilter provinsi spesifik: "${provArg}" (${targetProvinces.length} ditemukan)`);
  } else if (isSample) {
    // Ambil 2 provinsi dengan jumlah data kecil untuk uji coba cepat
    targetProvinces = provList
      .sort((a, b) => a.total_sekolah - b.total_sekolah)
      .slice(0, 2);
    console.log('🧪 Mode Sample diaktifkan: hanya memproses 2 provinsi terkecil.');
  }

  // Muat index lama jika ada untuk mempertahankan provinsi lain jika hanya ekspor sebagian
  const indexPath = path.join(OUTPUT_DIR, 'index.json');
  let existingIndex = { provinsi: [], npsn_prefix_map: {}, slug_map: {} };
  if (fs.existsSync(indexPath)) {
    try {
      existingIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    } catch (e) {}
  }

  const provMap = new Map((existingIndex.provinsi || []).map(p => [p.slug, p]));
  const slugMap = existingIndex.slug_map || {};
  const npsnPrefixMap = existingIndex.npsn_prefix_map || {};
  let totalAllSchools = 0;
  let sampleSchools = existingIndex.sample_schools || [];

  for (let i = 0; i < targetProvinces.length; i++) {
    const prov = targetProvinces[i];
    const slug = getSlug(prov.nama_provinsi);
    const fileName = `data_${slug}.json`;
    const filePath = path.join(OUTPUT_DIR, fileName);

    console.log(`\n[${i + 1}/${targetProvinces.length}] 📍 Memproses ${prov.nama_provinsi} (estimasi: ${prov.total_sekolah} sekolah)...`);

    try {
      const schools = await fetchSchoolsForProvince(prov.nama_provinsi, prov.total_sekolah);
      const MAX_PER_FILE = 30000;
      const partFiles = [];

      if (schools.length <= MAX_PER_FILE) {
        fs.writeFileSync(filePath, JSON.stringify(schools));
        partFiles.push(fileName);
        console.log(`\n   💾 Menyimpan ${schools.length} sekolah ke ${fileName}...`);
      } else {
        const totalParts = Math.ceil(schools.length / MAX_PER_FILE);
        for (let p = 0; p < totalParts; p++) {
          const chunk = schools.slice(p * MAX_PER_FILE, (p + 1) * MAX_PER_FILE);
          const partName = `data_${slug}_part${p + 1}.json`;
          fs.writeFileSync(path.join(OUTPUT_DIR, partName), JSON.stringify(chunk));
          partFiles.push(partName);
        }
        console.log(`\n   💾 Menyimpan ${schools.length} sekolah ke ${totalParts} bagian file (max 30.000/file agar < 25 MiB)...`);
        // Hapus file monolitik lama jika ada
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }

      // Catat mapping ke index
      provMap.set(slug, {
        nama: prov.nama_provinsi,
        slug,
        files: partFiles,
        total: schools.length,
      });

      slugMap[slug] = partFiles;
      slugMap[prov.nama_provinsi.toLowerCase()] = partFiles;

      // Petakan prefix NPSN (3 digit pertama) langsung ke file part
      for (let p = 0; p < partFiles.length; p++) {
        const chunk = schools.slice(p * MAX_PER_FILE, (p + 1) * MAX_PER_FILE);
        const fn = partFiles[p];
        for (const s of chunk) {
          if (s.npsn && s.npsn.length >= 3) {
            const prefix = s.npsn.substring(0, 3);
            if (!npsnPrefixMap[prefix]) {
              npsnPrefixMap[prefix] = [fn];
            } else if (!npsnPrefixMap[prefix].includes(fn)) {
              npsnPrefixMap[prefix].push(fn);
            }
          }
        }
      }

      // Ambil beberapa data untuk default sample jika belum ada
      if (sampleSchools.length < 20 && schools.length > 0) {
        sampleSchools.push(...schools.slice(0, 5));
      }

      totalAllSchools += schools.length;
    } catch (err) {
      console.error(`\n❌ Gagal memproses ${prov.nama_provinsi}:`, err.message);
    }
  }

  // 2. Simpan metadata index.json
  const finalIndex = {
    last_updated: new Date().toISOString(),
    total_provinsi: provMap.size,
    total_sekolah: Array.from(provMap.values()).reduce((sum, p) => sum + (p.total || 0), 0),
    provinsi: Array.from(provMap.values()).sort((a, b) => a.nama.localeCompare(b.nama)),
    slug_map: slugMap,
    npsn_prefix_map: npsnPrefixMap,
    sample_schools: sampleSchools.slice(0, 20),
  };

  fs.writeFileSync(indexPath, JSON.stringify(finalIndex, null, 2), 'utf8');
  console.log(`\n✅ Metadata index berhasil diperbarui di ${indexPath}`);

  const durationSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n🎉 SELESAI! Berhasil mengekspor data dalam ${durationSec} detik.`);
  console.log(`📂 File tersimpan di: ${OUTPUT_DIR}`);
}

run().catch(err => {
  console.error('Fatal error saat ekspor static provinsi:', err);
  process.exit(1);
});
