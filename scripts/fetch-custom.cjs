require('dotenv').config();
const fs = require('fs');

const WORKER_URL = process.env.CLOUDFLARE_WORKER_URL || 'https://api-sekolah-kita.pages.dev';
const CRON_SECRET = process.env.CRON_SECRET;

if (!CRON_SECRET) {
  console.error('CRON_SECRET belum diatur. Tambahkan secret CRON_SECRET di GitHub.');
  process.exit(1);
}

const BENTUK_GROUP = {
  "Semua": ['ALL'],
  "TK Sederajat": ['tk', 'ra', 'spk-tk', 'taman-seminari'],
  "KB Sederajat": ['kb', 'spk-kb', 'paudq'],
  "TPA & SPS": ['tpa', 'sps'],
  "SD Sederajat": ['sd', 'mi', 'sdtk', 'spk-sd', 'spm-ula', 'mula-dhammasekha'],
  "SMP Sederajat": ['smp', 'mts', 'smptk', 'spk-smp', 'spm-wustha', 'pdf-wustha', 'nava-dhammasekha'],
  "SMA Sederajat": ['sma', 'ma', 'smak', 'smtk', 'spk-sma', 'spm-ulya', 'pdf-ulya', 'uttama-dhammasekha', 'smag-k'],
  "SMK Sederajat": ['smk', 'mak'],
  "SLB": ['slb'],
  "Dikmas": ['pkbm', 'skb', 'kursus', 'pondok-pesantren']
};

let PROVINCES = {};

const cleanName = (name) => {
  if (!name) return "";
  let c = name.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  return c.replace(/^PROVINSI|^PROV/, '');
};

const getWibDate = (d = new Date()) => {
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? '' : new Date(dt.getTime() + 7 * 3600 * 1000).toISOString().split('T')[0];
};

const getWibDayOfWeek = (d = new Date()) => {
  const dt = new Date(d);
  return new Date(dt.getTime() + 7 * 3600 * 1000).getUTCDay() || 7;
};


async function loadProvinces() {
  try {
    console.log("Mengambil referensi kode wilayah provinsi dari API Belajar.id...");
    const res = await fetch('https://api.data.belajar.id/data-portal-backend/v2/master-data/satuan-pendidikan/jumlah-data-induk/360?limit=100&offset=0');
    const result = await res.json();
    if (result && result.data) {
      result.data.forEach(p => {
        PROVINCES[p.kodeWilayah] = p.namaWilayah;
      });
      PROVINCES["350000"] = "LUAR NEGERI"; // Pastikan Luar Negeri terdaftar
    }
  } catch (e) {
    console.error("Gagal mengambil referensi provinsi, menggunakan mode fallback", e);
    // Fallback darurat
    PROVINCES = {
      "010000": "DKI JAKARTA", "020000": "JAWA BARAT", "030000": "JAWA TENGAH", "040000": "DI YOGYAKARTA",
      "050000": "JAWA TIMUR", "060000": "ACEH", "070000": "SUMATERA UTARA", "080000": "SUMATERA BARAT",
      "090000": "RIAU", "100000": "JAMBI", "110000": "SUMATERA SELATAN", "120000": "LAMPUNG",
      "130000": "KALIMANTAN BARAT", "140000": "KALIMANTAN TENGAH", "150000": "KALIMANTAN SELATAN",
      "160000": "KALIMANTAN TIMUR", "170000": "SULAWESI UTARA", "180000": "SULAWESI TENGAH",
      "190000": "SULAWESI SELATAN", "200000": "SULAWESI TENGGARA", "210000": "MALUKU", "220000": "BALI",
      "230000": "NUSA TENGGARA BARAT", "240000": "NUSA TENGGARA TIMUR", "250000": "PAPUA", "260000": "BENGKULU",
      "270000": "MALUKU UTARA", "280000": "BANTEN", "290000": "KEPULAUAN BANGKA BELITUNG", "300000": "GORONTALO",
      "310000": "KEPULAUAN RIAU", "320000": "PAPUA BARAT", "330000": "SULAWESI BARAT", "340000": "KALIMANTAN UTARA",
      "350000": "LUAR NEGERI", "360000": "PAPUA TENGAH", "370000": "PAPUA SELATAN", "380000": "PAPUA PEGUNUNGAN", 
      "390000": "PAPUA BARAT DAYA"
    };
  }
}

async function postBatchToWorker(dataList, bentukAktif, offset, isFinished, customSyncParams = null) {
  const payload = { dataList, bentukAktif, offset, isFinished, customSync: true };
  if (customSyncParams) {
    payload.bentukList = customSyncParams.bentukList;
    payload.namaProvinsi = customSyncParams.namaProvinsi;
    payload.waktuMulai = customSyncParams.waktuMulai;
    payload.isStart = customSyncParams.isStart;
    payload.totalEstimasi = customSyncParams.totalEstimasi;
    if (customSyncParams.activeNpsnList) {
      payload.activeNpsnList = customSyncParams.activeNpsnList;
    }
    if (customSyncParams.isCleanScan !== undefined) {
      payload.isCleanScan = customSyncParams.isCleanScan;
    }
    if (customSyncParams.unrecognized_shapes !== undefined) {
      payload.unrecognized_shapes = customSyncParams.unrecognized_shapes;
    }
    if (customSyncParams.duplicates) {
      payload.duplicates = customSyncParams.duplicates;
    }
    if (customSyncParams.provStats) {
      payload.provStats = customSyncParams.provStats;
    }
  }
  const res = await fetch(`${WORKER_URL}/sync-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('Gagal push batch ke Worker: ' + await res.text());
  return await res.json();
}

async function cancelQueuedRunsGithub() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const currentRunId = process.env.GITHUB_RUN_ID ? String(process.env.GITHUB_RUN_ID) : null;
  if (!token || !repo) return;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs?status=queued`, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'api-sekolah-sync'
      }
    });
    if (!res.ok) return;
    const data = await res.json();
    const queuedRuns = (data.workflow_runs || []).filter(r => String(r.id) !== currentRunId);
    if (queuedRuns.length > 0) {
      console.log(`🧹 Membatalkan ${queuedRuns.length} antrean workflow menumpuk di GitHub Actions...`);
      for (const q of queuedRuns) {
        await fetch(`https://api.github.com/repos/${repo}/actions/runs/${q.id}/cancel`, {
          method: 'POST',
          headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'api-sekolah-sync'
          }
        });
        console.log(`  🗑️ Antrean Run #${q.id} (${q.name}) dibatalkan.`);
      }
    }
  } catch (e) {}
}

async function fetchCustomData() {
  await loadProvinces();
  await cancelQueuedRunsGithub();
  
  const argBentuk = process.env.PILIHAN_BENTUK || "Semua";
  const argProvinsi = (process.env.PILIHAN_PROVINSI || "Semua").trim().toUpperCase();
  const mulaiDariAwal = process.env.MULAI_DARI_AWAL === 'true';
  const isCronSchedule = process.env.IS_CRON_SCHEDULE === 'true';

  console.log(`Menjalankan sinkronisasi khusus...`);
  console.log(`- Bentuk Sekolah: ${argBentuk}`);
  console.log(`- Provinsi: ${argProvinsi}`);
  console.log(`- Mode Cron: ${isCronSchedule}`);

  let bentukList = [];
  if (argBentuk === "Semua") {
    try {
      console.log(`Mengambil daftar bentuk pendidikan dinamis dari Worker...`);
      const res = await fetch(`${WORKER_URL}/api/bentuk-pendidikan`);
      const json = await res.json();
      if (json.ok && json.data && json.data.length > 0) {
        bentukList = json.data;
        console.log(`Ditemukan ${bentukList.length} bentuk pendidikan di database.`);
      }
    } catch (e) {
      console.error(`Gagal mengambil bentuk pendidikan dari Worker: ${e.message}`);
    }
  } else {
    bentukList = BENTUK_GROUP[argBentuk];
  }

  if (!bentukList || bentukList.length === 0) {
    console.log(`Menggunakan fallback 37 bentuk pendidikan lengkap...`);
    bentukList = [
      'tk', 'kb', 'sps', 'tpa', 'paudq', 'sd', 'smp', 'sma', 'smk', 'slb',
      'skb', 'pkbm', 'kursus', 'ra', 'mi', 'mts', 'ma',
      'smak', 'smptk', 'smtk', 'sdtk', 'spk-kb', 'spk-sd', 'spk-sma', 'spk-smp', 'spk-tk',
      'spm-ula', 'spm-ulya', 'spm-wustha', 'taman-seminari', 'pdf-ulya', 'pdf-wustha',
      'mak', 'mula-dhammasekha', 'nava-dhammasekha', 'uttama-dhammasekha', 'pondok-pesantren',
      'smag-k'
    ];
  }
  
  let kodeWilayahList = [];
  if (argProvinsi === "SEMUA" || argProvinsi === "") {
    kodeWilayahList = Object.keys(PROVINCES);
  } else {
    const parts = argProvinsi.split(',').map(p => p.trim()).filter(p => p);
    for (const p of parts) {
      if (p.toUpperCase() === "SEMUA" || p.toUpperCase() === "ALL") {
        kodeWilayahList = Object.keys(PROVINCES);
        console.log(`Provinsi dikenali: SEMUA PROVINSI`);
        continue;
      }

      const searchP = p.replace(/[^A-Z0-9]/g, '');
      // 1. Coba cari exact match dulu
      let foundCode = Object.keys(PROVINCES).find(k => {
        const cleanK = k.replace(/[^A-Z0-9]/g, '');
        const cleanV = PROVINCES[k].replace(/[^A-Z0-9]/g, '');
        return cleanK === searchP || cleanV === searchP;
      });
      // 2. Jika tidak ada, baru coba substring match (.includes)
      if (!foundCode) {
        foundCode = Object.keys(PROVINCES).find(k => {
          const cleanV = PROVINCES[k].replace(/[^A-Z0-9]/g, '');
          return cleanV.includes(searchP);
        });
      }
      if (foundCode) {
        if (!kodeWilayahList.includes(foundCode)) kodeWilayahList.push(foundCode);
        console.log(`Provinsi dikenali: ${PROVINCES[foundCode]} (Kode: ${foundCode}) dari input '${p}'`);
      } else {
        console.log(`Peringatan: Provinsi '${p}' tidak dikenali, akan diabaikan.`);
      }
    }
    if (kodeWilayahList.length === 0) {
      console.log(`Tidak ada provinsi valid yang dimasukkan. Jatuh kembali ke sinkronisasi seluruh 39 provinsi.`);
      kodeWilayahList = Object.keys(PROVINCES);
    }
  }

  // --- SMART SYNC FILTER ---
  let skippedProvinces = [];
  if (isCronSchedule) {
    try {
      console.log(`Mengambil data perbandingan (Smart Sync) dari ${WORKER_URL}/api/compare...`);
      const compareRes = await fetch(`${WORKER_URL}/api/compare`);
      if (compareRes.ok) {
        const compareJson = await compareRes.json();
        if (compareJson.success && compareJson.data) {
          // Cek semua provinsi yang ada selisih (selisih != 0)
          // Kita gunakan raw_selisih jika ada (untuk mendeteksi npsn ganda/kosong), atau selisih biasa
          // Kedua hal ini menandakan ketidaksinkronan data.
          const currentDayOfWeek = getWibDayOfWeek();
          const isMandatoryUpdateDay = (currentDayOfWeek === 3 || currentDayOfWeek === 4);
          
          const SCHEDULE = {
            3: ["JAWA TIMUR", "JAWA TENGAH", "BANTEN", "LAMPUNG", "NUSA TENGGARA TIMUR", "RIAU", "SUMATERA BARAT", "DKI JAKARTA", "JAMBI", "DI YOGYAKARTA", "SULAWESI TENGGARA", "SULAWESI UTARA", "MALUKU", "MALUKU UTARA", "KEPULAUAN RIAU", "KEPULAUAN BANGKA BELITUNG", "PAPUA PEGUNUNGAN", "PAPUA TENGAH", "PAPUA BARAT DAYA", "LUAR NEGERI"],
            4: ["JAWA BARAT", "SUMATERA UTARA", "SULAWESI SELATAN", "SUMATERA SELATAN", "NUSA TENGGARA BARAT", "ACEH", "KALIMANTAN BARAT", "KALIMANTAN SELATAN", "SULAWESI TENGAH", "KALIMANTAN TENGAH", "KALIMANTAN TIMUR", "BALI", "BENGKULU", "SULAWESI BARAT", "GORONTALO", "PAPUA", "KALIMANTAN UTARA", "PAPUA BARAT", "PAPUA SELATAN"]
          };
  
          if (isCronSchedule) {
            if (isMandatoryUpdateDay) {
              console.log("🌟 Mode Full Sync Harian aktif! Memproses jadwal provinsi hari ini.");
              const scheduledNames = SCHEDULE[currentDayOfWeek];
              kodeWilayahList = scheduledNames.map(name => {
                 return Object.keys(PROVINCES).find(k => cleanName(PROVINCES[k]) === cleanName(name));
              }).filter(k => k);
            } else {
              console.log("🌟 Mode Smart Sync Global aktif! Mengabaikan jadwal harian dan memprioritaskan selisih terbesar dari SELURUH provinsi.");
              kodeWilayahList = Object.keys(PROVINCES);
            }
          }
  
          const todayDate = getWibDate();
          const diffCodes = compareJson.data.filter(d => {
            if (!kodeWilayahList.includes(d.kode)) return false;
            
            const isSynced = (Math.abs(d.selisih) === 0 && d.raw_selisih === 0) || (d.selisih === 0 && (d.api_duplicates || 0) > 0);
            if (isSynced && !isMandatoryUpdateDay) return false;
            
            if (isCronSchedule && d.terakhir_sukses) {
              const syncedDate = getWibDate(d.terakhir_sukses);
              
              if (isMandatoryUpdateDay) {
                // Pada hari wajib update (Rabu/Kamis), HANYA abaikan jika sudah disinkronkan HARI INI.
                // Jangan abaikan jika disinkronkan kemarin (Selasa/Rabu), karena hari ini adalah jadwal wajibnya (Full Sync).
                if (syncedDate === todayDate) {
                  console.log(`✅ ${d.nama} diabaikan (Sudah tersinkronisasi jadwal Full Sync hari ini)`);
                  return false;
                }
              } else {
                // Pada hari biasa (Smart Sync), abaikan HANYA jika sudah disinkronkan hari ini.
                // Jika disinkron kemarin namun masih ada selisih, ia akan disinkron ulang hari ini.
                if (syncedDate === todayDate) {
                  console.log(`✅ ${d.nama} diabaikan (Sudah tersinkronisasi hari ini, tunggu besok jika masih ada selisih)`);
                  return false;
                }
              }
            }
            return true;
          });
          const syncedCodes = compareJson.data.filter(d => d.selisih === 0 && (d.raw_selisih || 0) === 0 && kodeWilayahList.includes(d.kode));
  
          // Hitung total estimasi data provinsi yang terjadwal hari ini (Full Sync)
          const scheduledTodayTotal = (isMandatoryUpdateDay && SCHEDULE[currentDayOfWeek])
            ? SCHEDULE[currentDayOfWeek].reduce((sum, name) => {
                const p = compareJson.data.find(d => cleanName(d.nama) === cleanName(name));
                return sum + (p ? p.total_api : 0);
              }, 0)
            : 0;

          // Kuota aman penulisan baris per hari:
          // Pada hari Full Sync (Rabu & Kamis), alokasikan kuota yang cukup untuk menyelesaikan seluruh provinsi terjadwal (Rabu: ~303k, Kamis: ~252k).
          // Pada hari biasa (Smart Sync), batasi aman 100.000 data per hari.
          const dynamicFullSyncLimit = Math.max(scheduledTodayTotal + 15000, 350000);
          const BATAS_AMAN_DATA_PER_HARI = Math.max(100000, isMandatoryUpdateDay ? dynamicFullSyncLimit : 100000); 
          
          let totalDataSaatIni = compareJson.synced_today || 0;
          let finalTargets = [];
  
          console.log(`📊 Kuota yang sudah terpakai hari ini: ${totalDataSaatIni.toLocaleString('id-ID')} / ${BATAS_AMAN_DATA_PER_HARI.toLocaleString('id-ID')}`);
  
          // Urutkan provinsi berdasarkan aturan prioritas:
          if (isMandatoryUpdateDay && isCronSchedule) {
            diffCodes.sort((a, b) => {
               const scheduleArr = SCHEDULE[currentDayOfWeek] || [];
               const indexA = scheduleArr.findIndex(s => cleanName(s) === cleanName(a.nama));
               const indexB = scheduleArr.findIndex(s => cleanName(s) === cleanName(b.nama));
               return (indexA !== -1 ? indexA : 999) - (indexB !== -1 ? indexB : 999);
            });
          } else {
            diffCodes.sort((a, b) => {
              const aHasSynced = a.terakhir_sukses ? 1 : 0;
              const bHasSynced = b.terakhir_sukses ? 1 : 0;
              
              if (aHasSynced !== bHasSynced) {
                return aHasSynced - bHasSynced; // 0 (belum sinkron) duluan
              }
  
              const aIsDifferent = (Math.abs(a.selisih) > 0 || Math.abs(a.raw_selisih) > 0) ? 1 : 0;
              const bIsDifferent = (Math.abs(b.selisih) > 0 || Math.abs(b.raw_selisih) > 0) ? 1 : 0;
              
              if (aIsDifferent !== bIsDifferent) {
                 return bIsDifferent - aIsDifferent; // 1 (berbeda) duluan
              }
              
              if (aHasSynced && bHasSynced) {
                 const timeA = new Date(a.terakhir_sukses).getTime();
                 const timeB = new Date(b.terakhir_sukses).getTime();
                 if (timeA !== timeB) return timeA - timeB; // Terlama duluan agar bergiliran
              }
  
              const maxDiffA = Math.abs(a.selisih);
              const maxDiffB = Math.abs(b.selisih);
              return maxDiffB - maxDiffA; // Sisanya urutkan berdasarkan selisih terbesar
            });
          }
  
          for (const p of diffCodes) {
            if (totalDataSaatIni + p.total_api <= BATAS_AMAN_DATA_PER_HARI) {
              finalTargets.push(p.kode);
              totalDataSaatIni += p.total_api;
            } else if (finalTargets.length === 0 && totalDataSaatIni === 0) {
              // Jika hari ini belum sinkron SAMA SEKALI dan tidak ada yang muat, paksa eksekusi 1 yang pertama agar tidak deadlock
              finalTargets.push(p.kode);
              totalDataSaatIni += p.total_api;
              break;
            }
          }
  
          if (fs.existsSync('ada_sisa_harian.json')) {
            try { fs.unlinkSync('ada_sisa_harian.json'); } catch(e) {}
          }

          if (finalTargets.length === 0) {
            console.log(`✅ SEMUA PROVINSI SUDAH SINKRON. Tidak ada yang perlu disinkronkan. Membatalkan sinkronisasi untuk menghemat resource.`);
            kodeWilayahList = [];
          } else {
            const targetNames = finalTargets.map(k => k === "350000" ? "LUAR NEGERI" : (PROVINCES[k] || k));
            console.log(`🚀 Smart Sync Cerdas mendeteksi ${diffCodes.length} provinsi dengan data tidak sinkron.`);
            console.log(`   Memilih ${finalTargets.length} provinsi [${targetNames.join(', ')}] untuk disinkronisasi hari ini dengan estimasi ~${totalDataSaatIni.toLocaleString('id-ID')} data.`);
            if (diffCodes.length > finalTargets.length) {
               if (totalDataSaatIni < BATAS_AMAN_DATA_PER_HARI) {
                 const sisaProv = diffCodes.length - finalTargets.length;
                 console.log(`   ⚠️ Masih ada sisa ${sisaProv} provinsi di antrean hari ini dan kuota harian (${totalDataSaatIni.toLocaleString('id-ID')} / ${BATAS_AMAN_DATA_PER_HARI.toLocaleString('id-ID')}) belum penuh. Membuat flag auto-continue...`);
                 fs.writeFileSync('ada_sisa_harian.json', JSON.stringify({ sisaProv, totalDataSaatIni }));
               } else {
                 console.log(`   ⚠️ Sisa ${diffCodes.length - finalTargets.length} provinsi akan otomatis antre untuk dieksekusi besok karena batas aman harian (${BATAS_AMAN_DATA_PER_HARI.toLocaleString('id-ID')} data) sudah penuh.`);
               }
            }
            kodeWilayahList = finalTargets;
          }
  
          // Tandai provinsi yang di-skip karena sudah sinkron ke database agar mendapat centang hijau di Dashboard
          skippedProvinces = syncedCodes.map(d => d.kode);
          if (skippedProvinces.length > 0) {
            const provNames = skippedProvinces.map(k => k === "350000" ? "LUAR NEGERI" : (PROVINCES[k] || "")).filter(n => n);
            if (provNames.length > 0) {
              console.log(`Menandai ${provNames.length} provinsi sebagai sinkron di database...`);
              try {
                await fetch(`${WORKER_URL}/mark-synced`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET },
                  body: JSON.stringify({ provinsiList: provNames })
                });
              } catch (err) {
                console.log(`Gagal memanggil /mark-synced: ${err.message}`);
              }
            }
          }
        } else {
          console.log(`Gagal mem-parsing data Smart Sync. Akan menyinkronkan target secara default.`);
        }
      } else {
        console.log(`Gagal menghubungi API Smart Sync. Akan menyinkronkan target secara default.`);
      }
    } catch (e) {
      console.log(`Error saat mengecek Smart Sync: ${e.message}. Akan menyinkronkan target secara default.`);
    }
  } else {
    console.log(`🌟 Sinkronisasi manual terdeteksi (Mode Cron: false). Melewati filter Smart Sync untuk menarik ulang data secara penuh.`);
  }

  if (kodeWilayahList.length === 0) return;

  // Buat daftar antrean task: kombinasi tiap provinsi dan tiap bentuk sekolah
  const tasks = [];
  for (const prov of kodeWilayahList) {
    for (const bentuk of bentukList) {
      tasks.push({ prov, bentuk });
    }
  }

  let taskIndex = 0;
  let offset = 0;
  let waktuMulai = process.env.WAKTU_MULAI || "";

  if (!mulaiDariAwal) {
    taskIndex = parseInt(process.env.LANJUTAN_INDEX || '0', 10);
    offset = parseInt(process.env.LANJUTAN_OFFSET || '0', 10);
    if (taskIndex > 0 || offset > 0) {
      const t = tasks[Math.min(taskIndex, tasks.length - 1)];
      console.log(`Melanjutkan dari iterasi sebelumnya: Provinsi ${PROVINCES[t.prov] || 'SEMUA'}, Bentuk ${t.bentuk}, Offset ${offset}`);
    } else {
      // Periksa posisi sinkronisasi terakhir di server jika ada sesi sebelumnya yang belum selesai
      try {
        console.log(`🔍 Memeriksa progres sinkronisasi terakhir dari server (${WORKER_URL}/api/sync-status)...`);
        const statusRes = await fetch(`${WORKER_URL}/api/sync-status`);
        if (statusRes.ok) {
          const statusJson = await statusRes.json();
          if (statusJson && !statusJson.selesai && statusJson.activeRow) {
            const act = statusJson.activeRow;
            const actBentukRaw = act.bentuk_aktif || '';
            const actOffset = act.offset_terakhir || 0;
            const actProvince = (statusJson.activeProvince || '').trim().toUpperCase();

            let targetShape = '';
            let targetProv = actProvince;
            const shapeMatch = actBentukRaw.match(/^(.*?)\s*\((.*?)\)$/);
            if (shapeMatch) {
              targetShape = shapeMatch[1].trim().toLowerCase();
              if (!targetProv) targetProv = shapeMatch[2].trim().toUpperCase();
            } else if (actBentukRaw) {
              targetShape = actBentukRaw.trim().toLowerCase();
            }

            if (targetProv && targetShape) {
              const cleanTargetProv = cleanName(targetProv);
              const foundIdx = tasks.findIndex(t => {
                const pName = (PROVINCES[t.prov] || '').toUpperCase();
                return cleanName(pName) === cleanTargetProv && t.bentuk.toLowerCase() === targetShape;
              });

              if (foundIdx !== -1) {
                taskIndex = foundIdx;
                offset = actOffset;
                console.log(`🔄 Melanjutkan otomatis dari posisi terpotong: Provinsi ${targetProv}, Bentuk [${targetShape.toUpperCase()}], Offset ${offset} (Antrean #${taskIndex + 1}/${tasks.length})`);
              } else {
                const provOnlyIdx = tasks.findIndex(t => {
                  const pName = (PROVINCES[t.prov] || '').toUpperCase();
                  return cleanName(pName) === cleanTargetProv;
                });
                if (provOnlyIdx !== -1) {
                  taskIndex = provOnlyIdx;
                  offset = 0;
                  console.log(`🔄 Melanjutkan otomatis dari provinsi terpotong: ${targetProv} (Antrean #${taskIndex + 1}/${tasks.length})`);
                }
              }
            }
          }
        }
      } catch (errResume) {
        console.warn('⚠️ Gagal mengambil posisi lanjutan otomatis dari server:', errResume.message);
      }
    }
  }

  let isFirstBatch = false;
  if (!waktuMulai) {
    // Buat waktu mulai baru dalam format UTC+7 YYYY-MM-DD HH:MM:SS
    const d = new Date(new Date().getTime() + 7 * 3600 * 1000);
    waktuMulai = d.toISOString().replace('T', ' ').substring(0, 19);
    console.log(`Waktu mulai sync baru: ${waktuMulai}`);
    isFirstBatch = true;
  } else {
    console.log(`Menggunakan waktu mulai dari iterasi sebelumnya: ${waktuMulai}`);
  }

  const limit = 20;
  const startTime = Date.now();
  const maxMinutes = parseInt(process.env.MAX_EXECUTION_MINUTES || '50', 10);
  const LAMA_MAKSIMAL = maxMinutes * 60 * 1000;

  let previousProv = null;
  let currentProvinceStarted = false;
  let currentTotalEstimasi = 0;
  
  let provinceStartedCleanly = {};
  let activeNpsnsByProv = {};
  let totalPulledByProv = {};
  let allSchoolsByProv = {};

  let currentBentukEstimasi = 0;
  let provStats = { baru: 0, diperbarui: 0, tidakBerubah: 0 };

  async function performProvinceCleanup(kodeWilayah, namaWilayah) {
    console.log(`✨ Selesai sinkronisasi seluruh bentuk untuk provinsi ${kodeWilayah} (${namaWilayah}). Melakukan pembersihan...`);
    const provNameDB = kodeWilayah === "360" ? "SEMUA" : PROVINCES[kodeWilayah];
    
    let fullNpsnList = [];
    let unrecognized_shapes = 0;
    let nonQueryableCount = 0;
    if (provinceStartedCleanly[kodeWilayah]) {
      fullNpsnList = activeNpsnsByProv[kodeWilayah] || [];
      unrecognized_shapes = currentTotalEstimasi - (totalPulledByProv[kodeWilayah] || 0);
      if (unrecognized_shapes < 0) unrecognized_shapes = 0;
      console.log(`Mengirim ${fullNpsnList.length} NPSN aktif ke Worker untuk deteksi penghapusan data... (Indikasi Bentuk Baru: ${unrecognized_shapes})`);
      if (unrecognized_shapes > 0) {
        console.log(`⚠️ Terdeteksi ${unrecognized_shapes} sekolah dari bentuk pendidikan yang belum terdaftar! Menjalankan Discovery Scan...`);
        const scanRes = await runDiscoveryScan(kodeWilayah, bentukList, currentTotalEstimasi, fullNpsnList, unrecognized_shapes);
        if (scanRes && scanRes.nonQueryableSchools) {
          allSchoolsByProv[kodeWilayah].push(...scanRes.nonQueryableSchools);
        }
        if (scanRes && scanRes.nonQueryableCount > 0) {
          nonQueryableCount = scanRes.nonQueryableCount;
          unrecognized_shapes -= scanRes.nonQueryableCount;
          if (unrecognized_shapes < 0) unrecognized_shapes = 0;
        } else if (unrecognized_shapes > 0) {
          nonQueryableCount = unrecognized_shapes;
        }
      }
    } else {
      console.log(`Pembersihan dilewati karena provinsi disinkronisasi sebagian pada sesi ini.`);
    }

    let duplicates = [];
    if (provinceStartedCleanly[kodeWilayah]) {
      const schools = allSchoolsByProv[kodeWilayah] || [];
      
      const npsnMap = new Map();
      for (const school of schools) {
        if (!school.npsn) continue;
        if (!npsnMap.has(school.npsn)) {
          npsnMap.set(school.npsn, []);
        }
        npsnMap.get(school.npsn).push(school);
      }
      
      for (const [npsn, schoolList] of npsnMap.entries()) {
        if (schoolList.length > 1) {
          duplicates.push({
            npsn,
            sekolahList: schoolList.map(s => ({
              nama: s.nama || '',
              bentuk: s.bentukPendidikan || '',
              status: s.statusSatuanPendidikan || '',
              kecamatan: s.namaKecamatan || '',
              kabupaten: s.namaKabupaten || '',
              alamat: s.alamatJalan || ''
            }))
          });
        }
      }
      console.log(`📊 Terdeteksi ${duplicates.length} NPSN ganda di data API Provinsi ${provNameDB}.`);
    }

    try {
      const { stats } = await postBatchToWorker([], 'tk', 0, true, {
        bentukList: ['ALL'],
        namaProvinsi: provNameDB,
        waktuMulai: waktuMulai,
        activeNpsnList: fullNpsnList,
        unrecognized_shapes: unrecognized_shapes,
        nonQueryableCount: nonQueryableCount,
        totalEstimasi: currentTotalEstimasi,
        duplicates,
        isCleanScan: provinceStartedCleanly[kodeWilayah],
        kodeWilayah,
        provStats
      });
      console.log(`🧹 Berhasil membersihkan data lama untuk ${provNameDB}. ${stats?.dihapus || 0} sekolah dihapus dan aktivitas dicatat.`);
    } catch (e) {
      console.error(`Gagal membersihkan data lama untuk ${provNameDB}:`, e);
    }
  }

  while (taskIndex < tasks.length) {
    if (Date.now() - startTime >= LAMA_MAKSIMAL) {
      console.log(`\n⏱️ Waktu eksekusi mendekati batas (${LAMA_MAKSIMAL / 1000 / 60} menit). Menyimpan status dan berhenti rapi...`);
      const currentT = tasks[taskIndex];
      const nextProv = PROVINCES[currentT.prov] || currentT.prov;
      console.log(`📌 Posisi terpotong berhasil tersimpan di server: Provinsi ${nextProv}, Bentuk [${currentT.bentuk.toUpperCase()}], Offset ${offset}.`);
      console.log(`➡️ Proses selesai dengan rapi (exit 0) dan akan dilanjutkan otomatis dari titik ini pada giliran berikutnya.`);
      await cancelQueuedRunsGithub();
      break;
    }

    const currentTask = tasks[taskIndex];
    const kodeWilayah = currentTask.prov;
    const namaWilayah = kodeWilayah === "360" ? "SEMUA" : (PROVINCES[kodeWilayah] || kodeWilayah);
    
    if (kodeWilayah !== previousProv) {
      await cancelQueuedRunsGithub();
      // Hanya benar-benar START BARU jika offset === 0 dan ini adalah bentukPendidikan PERTAMA dari provinsi tersebut!
      const isVeryBeginningOfProvince = (offset === 0) && (taskIndex === tasks.findIndex(t => t.prov === kodeWilayah));
      currentProvinceStarted = !isVeryBeginningOfProvince; 
      previousProv = kodeWilayah;
      
      provinceStartedCleanly[kodeWilayah] = isVeryBeginningOfProvince;
      activeNpsnsByProv[kodeWilayah] = [];
      allSchoolsByProv[kodeWilayah] = [];
      totalPulledByProv[kodeWilayah] = 0;
      provStats = { baru: 0, diperbarui: 0, tidakBerubah: 0 };
      
      try {
        const totalUrl = `https://api.data.belajar.id/data-portal-backend/v2/master-data/satuan-pendidikan/daftar-data-induk/${kodeWilayah}?limit=1&offset=0`;
        const totalRes = await fetch(totalUrl);
        const totalJson = await totalRes.json();
        currentTotalEstimasi = totalJson.meta ? totalJson.meta.total : 0;
        console.log(`📊 Estimasi total data untuk provinsi ${kodeWilayah} (${namaWilayah}): ${currentTotalEstimasi}`);
      } catch (err) {
        console.error(`Gagal mendapatkan estimasi total data:`, err);
        currentTotalEstimasi = 0;
      }

      if (isVeryBeginningOfProvince) {
        try {
          const provNameDB = kodeWilayah === "360" ? "SEMUA" : (PROVINCES[kodeWilayah] || kodeWilayah);
          console.log(`🚀 Mengirim status awal sinkronisasi untuk provinsi ${provNameDB} ke server...`);
          await postBatchToWorker([], currentTask.bentuk, 0, false, {
            bentukList,
            namaProvinsi: provNameDB,
            waktuMulai,
            isStart: true,
            totalEstimasi: currentTotalEstimasi
          });
        } catch (e) {
          console.warn(`Peringatan: Gagal mengirim status awal ${namaWilayah}:`, e.message);
        }
      }
    }

    if (offset === 0) {
      currentBentukEstimasi = 0;
    }

    const bentukAktif = currentTask.bentuk;
    let url = `https://api.data.belajar.id/data-portal-backend/v2/master-data/satuan-pendidikan/daftar-data-induk/${kodeWilayah}?limit=${limit}&offset=${offset}&sortBy=npsn`;
    if (bentukAktif !== 'ALL') {
      url += `&bentukPendidikan=${bentukAktif}`;
    }

    try {
      console.log(`Mengecek API [${bentukAktif.toUpperCase()}] wilayah ${kodeWilayah} (${namaWilayah}) offset ${offset}...`);
      const response = await fetch(url);
      
      if (response.status === 400) {
        console.log(`⚠️ Bentuk pendidikan "${bentukAktif}" tidak valid di API kementerian (400 Bad Request).`);
        try {
          console.log(`Menghapus bentuk "${bentukAktif}" dari database bentuk_pendidikan...`);
          const delRes = await fetch(`${WORKER_URL}/api/bentuk-pendidikan?secret=${CRON_SECRET}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bentuk: bentukAktif })
          });
          if (delRes.ok) {
            console.log(`✅ Berhasil menghapus bentuk "${bentukAktif}" dari database.`);
          } else {
            console.error(`⚠️ Gagal menghapus bentuk "${bentukAktif}":`, await delRes.text());
          }
        } catch (e) {
          console.error(`⚠️ Gagal menghapus bentuk "${bentukAktif}":`, e.message);
        }
        
        // Hapus dari bentukList agar tidak dihitung saat pembersihan
        const idx = bentukList.indexOf(bentukAktif);
        if (idx > -1) {
          bentukList.splice(idx, 1);
        }
        
        offset = 0;
        taskIndex++;
        console.log(`➡️ Mengabaikan bentuk tidak valid [${bentukAktif.toUpperCase()}]. Pindah ke antrean berikutnya.`);
        
        const isProvinceFinished = taskIndex >= tasks.length || tasks[taskIndex].prov !== kodeWilayah;
        if (isProvinceFinished) {
          await performProvinceCleanup(kodeWilayah, namaWilayah);
        }
        continue;
      }

      const result = await response.json();
      const dataList = result.data || [];

      if (result.meta && result.meta.total !== undefined) {
        currentBentukEstimasi = result.meta.total;
      }

      if (dataList.length === 0) {
        if (currentBentukEstimasi > 0 && offset < currentBentukEstimasi) {
          console.log(`⚠️ Peringatan: API mengembalikan 0 data di offset ${offset} (belum mencapai estimasi ${currentBentukEstimasi}). Melompat ke halaman berikutnya...`);
          offset += limit;
          continue;
        }
        
        offset = 0;
        taskIndex++;
        console.log(`➡️ Selesai untuk tipe sekolah [${bentukAktif.toUpperCase()}] wilayah ${kodeWilayah} (${namaWilayah}). Pindah ke antrean berikutnya.`);
        
        const isProvinceFinished = taskIndex >= tasks.length || tasks[taskIndex].prov !== kodeWilayah;
        if (isProvinceFinished) {
          await performProvinceCleanup(kodeWilayah, namaWilayah);
        }
        continue;
      }

      offset += limit;
      
      const provNameDB = kodeWilayah === "360" ? "SEMUA" : PROVINCES[kodeWilayah];
      const isStartProv = !currentProvinceStarted;
      
      if (dataList && dataList.length > 0 && provinceStartedCleanly[kodeWilayah]) {
         activeNpsnsByProv[kodeWilayah].push(...dataList.map(d => d.npsn).filter(Boolean));
         allSchoolsByProv[kodeWilayah].push(...dataList);
         totalPulledByProv[kodeWilayah] += dataList.length;
      }

      const customParams = {
        bentukList,
        namaProvinsi: provNameDB,
        waktuMulai,
        isStart: isStartProv,
        totalEstimasi: currentTotalEstimasi
      };
      
      const { stats } = await postBatchToWorker(dataList, bentukAktif, offset, false, customParams);
      currentProvinceStarted = true;
      if (stats) {
        provStats.baru += (stats.baru || 0);
        provStats.diperbarui += (stats.diperbarui || 0);
        provStats.tidakBerubah += (stats.tidakBerubah || 0);
      }
      
      console.log(`Offset ${offset - limit} [${bentukAktif}]: ${dataList.length} ditarik — ${stats.tidakBerubah} tetap, ${stats.baru} baru, ${stats.diperbarui} update.`);

      const jedaMs = stats.baru === 0 && stats.diperbarui === 0 ? 200 : 1000;
      await new Promise((resolve) => setTimeout(resolve, jedaMs));

      // Cek batas waktu eksekusi agar keluar rapi sebelum runner di-kill paksa
      if (Date.now() - startTime >= LAMA_MAKSIMAL) {
        console.log(`\n⏱️ Batas waktu eksekusi run (${maxMinutes} menit) telah tercapai.`);
        const currentT = tasks[taskIndex];
        const nextProv = PROVINCES[currentT.prov] || currentT.prov;
        console.log(`📌 Posisi terpotong berhasil tersimpan di server: Provinsi ${nextProv}, Bentuk [${bentukAktif.toUpperCase()}], Offset ${offset}.`);
        console.log(`➡️ Proses selesai dengan rapi (exit 0) dan akan dilanjutkan otomatis dari titik ini pada giliran berikutnya.`);
        await cancelQueuedRunsGithub();
        break;
      }

    } catch (err) {
      console.error(`Gagal mengambil data dari API untuk bentuk ${bentukAktif}:`, err);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  
  if (taskIndex >= tasks.length) {
    console.log("🎉 SINKRONISASI KHUSUS SELESAI! Mengirim status final ke server...");
    try {
      await postBatchToWorker([], 'Selesai', 0, true, {
        namaProvinsi: 'SEMUA',
        waktuMulai,
        isStart: false,
        totalEstimasi: currentTotalEstimasi
      });
      console.log("✅ Berhasil memperbarui status penyelesaian sinkronisasi.");
    } catch (err) {
      console.warn("Peringatan: Gagal mengirim status final:", err.message);
    }
  }
}

async function runDiscoveryScan(kodeWilayah, bentukList, totalEstimasi, fullNpsnList, unrecognizedCount) {
  const limit = 20;
  const initialScannedShapes = new Set(bentukList.map(b => b.replace(/\s+/g, '-')));
  const scannedShapes = new Set(initialScannedShapes);
  
  const testingShapes = new Map(); // bNormalized -> Promise<boolean> (true if valid, false if invalid)
  const nonQueryableSchools = [];
  const allScannedSchools = [];
  let foundNew = false;
  
  const maxPages = totalEstimasi ? Math.ceil(totalEstimasi / limit) : 350;
  
  const concurrencyLimit = parseInt(process.env.DISCOVERY_CONCURRENCY || '20', 10) || 20;
  console.log(`Menjalankan scan discovery sebanyak maksimal ${maxPages} halaman dengan concurrency limit ${concurrencyLimit}...`);
  
  let isAborted = false;
  let foundUnrecognizedCount = 0;
  
  const offsets = [];
  for (let page = 0; page < maxPages; page++) {
    offsets.push(page * limit);
  }
  
  let offsetIndex = 0;
  
  const fetchPage = async (offset) => {
    if (isAborted) return [];
    const url = `https://api.data.belajar.id/data-portal-backend/v2/master-data/satuan-pendidikan/daftar-data-induk/${kodeWilayah}?limit=${limit}&offset=${offset}&sortBy=npsn`;
    try {
      const res = await fetch(url);
      const json = await res.json();
      return json.data || [];
    } catch (err) {
      console.error(`Discovery Scan gagal di offset ${offset}:`, err.message);
      return [];
    }
  };

  const processPage = async (offset) => {
    if (isAborted) return;
    
    const data = await fetchPage(offset);
    if (data.length === 0 || isAborted) {
      return;
    }
    allScannedSchools.push(...data);
    
    for (const school of data) {
      if (isAborted) break;
      if (!school.bentukPendidikan) continue;
      const bRaw = school.bentukPendidikan;
      const bNormalized = bRaw.toLowerCase().trim().replace(/\s+/g, '-');
      
      if (bNormalized && !initialScannedShapes.has(bNormalized)) {
        foundUnrecognizedCount++;
        
        if (!testingShapes.has(bNormalized)) {
          const testPromise = (async () => {
            if (isAborted) return false;
            const testUrl = `https://api.data.belajar.id/data-portal-backend/v2/master-data/satuan-pendidikan/daftar-data-induk/${kodeWilayah}?limit=1&offset=0&bentukPendidikan=${bNormalized}`;
            try {
              const testRes = await fetch(testUrl);
              const testText = await testRes.text();
              if (testRes.status === 400 || testText.includes("invalid bentuk pendidikan")) {
                console.log(`⚠️ Bentuk pendidikan "${bRaw}" (${bNormalized}) tidak dapat dikueri di API filter (400 Bad Request). Akan disinkronkan manual.`);
                return false;
              } else {
                console.log(`✨ Menemukan bentuk pendidikan baru queryable dari API: "${bNormalized}" (${bRaw}) di sekolah "${school.nama}"`);
                const addRes = await fetch(`${WORKER_URL}/api/bentuk-pendidikan?secret=${CRON_SECRET}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ bentuk: bNormalized })
                });
                if (addRes.ok) {
                  console.log(`✅ Berhasil mendaftarkan bentuk "${bNormalized}" ke database.`);
                  return true;
                } else {
                  console.error(`⚠️ Gagal mendaftarkan bentuk "${bNormalized}":`, await addRes.text());
                  return false;
                }
              }
            } catch (err) {
              console.error(`Gagal menguji keabsahan bentuk "${bNormalized}":`, err.message);
              return false;
            }
          })();
          testingShapes.set(bNormalized, testPromise);
        }
        
        const isValid = await testingShapes.get(bNormalized);
        if (isValid) {
          if (!scannedShapes.has(bNormalized)) {
            scannedShapes.add(bNormalized);
            bentukList.push(bNormalized);
            foundNew = true;
          }
        } else {
          if (school.npsn) {
            nonQueryableSchools.push(school);
            if (!fullNpsnList.includes(school.npsn)) {
              fullNpsnList.push(school.npsn);
            }
          }
        }
        
        if (unrecognizedCount !== undefined && foundUnrecognizedCount >= unrecognizedCount) {
          console.log(`🎯 Berhasil menemukan seluruh (${unrecognizedCount}) sekolah bentuk baru/non-queryable. Menghentikan scan discovery lebih awal!`);
          isAborted = true;
          break;
        }
      }
    }
  };

  const runWorker = async () => {
    while (offsetIndex < offsets.length && !isAborted) {
      const currentOffset = offsets[offsetIndex++];
      await processPage(currentOffset);
    }
  };

  const workers = [];
  for (let i = 0; i < Math.min(concurrencyLimit, offsets.length); i++) {
    workers.push(runWorker());
  }

  await Promise.all(workers);
  
  if (nonQueryableSchools.length > 0) {
    console.log(`Upserting ${nonQueryableSchools.length} sekolah dengan bentuk pendidikan non-queryable langsung ke database...`);
    try {
      await postBatchToWorker(nonQueryableSchools, 'ALL', 0, false);
      console.log(`✅ Sukses menyinkronkan langsung sekolah non-queryable.`);
    } catch (e) {
      console.error(`⚠️ Gagal menyinkronkan langsung sekolah non-queryable:`, e.message);
    }
  }
  
  if (foundNew) {
    console.log(`💡 Pendaftaran bentuk baru selesai. Silakan jalankan ulang sinkronisasi agar data bentuk baru ini ditarik penuh.`);
  } else {
    console.log(`Discovery Scan selesai. Tidak ada bentuk pendidikan baru yang dapat dikueri.`);
  }
  
  return {
    foundNew,
    nonQueryableCount: nonQueryableSchools.length,
    nonQueryableSchools,
    allScannedSchools
  };
}

fetchCustomData();
