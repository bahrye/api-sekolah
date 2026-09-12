import { getSupabase } from './lib/db.js';
import { VALID_BENTUK } from './lib/sync-supabase-core.js';


const parseDateMs = (dStr) => {
  if (!dStr) return 0;
  if (typeof dStr === 'number') return dStr;
  const s = String(dStr).trim();
  if (s.includes('Z') || s.includes('+') || /T.*[+-]\d{2}/.test(s)) {
    const t = new Date(s).getTime();
    if (!isNaN(t)) return t;
  }
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) {
    const iso = s.replace(' ', 'T') + 'Z';
    const t = new Date(iso).getTime();
    if (!isNaN(t)) return t;
  }
  const t = new Date(s).getTime();
  return isNaN(t) ? 0 : t;
};

const formatWIB = (dStr) => {
  if (!dStr) return '-';
  if (typeof dStr === 'string' && dStr.includes('WIB')) return dStr;
  const ms = parseDateMs(dStr);
  if (!ms) return dStr;
  const d = new Date(ms + 7 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const Y = d.getUTCFullYear();
  const M = pad(d.getUTCMonth() + 1);
  const D = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const m = pad(d.getUTCMinutes());
  return `${D}-${M}-${Y} ${h}:${m} WIB`;
};

const cleanName = (name) => {
  if (!name) return '';
  return name.replace(/[^A-Z0-9]/gi, '').toUpperCase().replace(/^PROVINSI|^PROV/, '');
};

const getWibDate = (d = new Date()) => {
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? '' : new Date(dt.getTime() + 7 * 3600 * 1000).toISOString().split('T')[0];
};

const getWibDayOfWeek = (d = new Date()) => {
  const dt = new Date(d);
  return new Date(dt.getTime() + 7 * 3600 * 1000).getUTCDay() || 7;
};

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const supabase = getSupabase(env);
  const clientSupabaseUrl = env?.SUPABASE_URL || 'https://xikrjtbaqtidnifnkpxd.supabase.co';
  const clientSupabaseAnonKey = env?.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhpa3JqdGJhcXRpZG5pZm5rcHhkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwMDMxNDcsImV4cCI6MjA5NjU3OTE0N30.ARW-hXikuKeOiYqAwTcBkqXMpyKaPPulPqF4O2hFzXA';

  try {
    const { data: results } = await supabase
      .from('status_sinkronisasi')
      .select('*')
      .in('id', [1, 2]);

    let provStatusList = [];
    let compareCache = null;
    try {
      const { data: provRes } = await supabase
        .from('provinsi_sync_status')
        .select('*');
      provStatusList = provRes || [];

      let vRekapList = [];
      try {
        const { data: vRekap } = await supabase
          .from('v_rekap_provinsi')
          .select('*');
        vRekapList = vRekap || [];
      } catch (eV) {}

      const { data: cacheRow } = await supabase
        .from('cache_data')
        .select('value, updated_at')
        .eq('key', 'perbandingan')
        .single();
      if (cacheRow && cacheRow.value) {
        const rawCompare = JSON.parse(cacheRow.value);
        const vMap = new Map(vRekapList.map(r => [cleanName(r.nama_provinsi), r.total_sekolah]));
        const pMap = new Map(provStatusList.map(r => [cleanName(r.nama_provinsi), r]));
        const todayDateWIB = getWibDate();

        rawCompare.forEach(item => {
          const cName = cleanName(item.nama);
          if (vMap.has(cName)) {
            item.total_db = vMap.get(cName);
          } else if (pMap.has(cName) && pMap.get(cName).total_db > 0) {
            item.total_db = pMap.get(cName).total_db;
          }

          if (pMap.has(cName)) {
            const p = pMap.get(cName);
            if (p.terakhir_sukses) item.terakhir_sukses = p.terakhir_sukses;
            item.api_duplicates = p.api_duplicates || 0;
            item.api_empty_npsn = p.api_empty_npsn || 0;
            item.api_unrecognized_shapes = p.api_unrecognized_shapes || 0;
          }

          item.raw_selisih = (item.total_api || 0) - (item.total_db || 0);
          item.selisih = item.raw_selisih - (item.api_duplicates || 0);
          item.extra_in_db = Math.max(0, (item.total_db || 0) - (item.total_api || 0));

          const isSyncedToday = Boolean(item.terakhir_sukses && getWibDate(item.terakhir_sukses) === todayDateWIB);
          item.is_sinkron_walau_selisih = (item.selisih === 0);
        });

        compareCache = { value: rawCompare, updated_at: cacheRow.updated_at };
      }
    } catch (e) {}
let row1 = results?.find(r => r.id === 1) || { bentuk_aktif: 'tk', offset_terakhir: 0 };
        let row2 = results?.find(r => r.id === 2);

        let activeRow = row1;
        let isCustom = false;

        if (row2 && row2.updated_at && row1.updated_at) {
          const t1 = parseDateMs(row1.updated_at);
          const t2 = parseDateMs(row2.updated_at);
          if (t2 > t1) {
            activeRow = row2;
            isCustom = true;
          }
        } else if (row2 && !row1.updated_at) {
          activeRow = row2;
          isCustom = true;
        }

        const bentukBerikutnya = activeRow.bentuk_aktif || 'tk';
        const offsetBerikutnya = activeRow.offset_terakhir || 0;

        const totalSynced = (activeRow.total_baru || 0) + (activeRow.total_diperbarui || 0) + (activeRow.total_tidak_berubah || 0);
        const totalEstimasi = activeRow.total_estimasi || totalSynced || (isCustom ? 12654 : 553456);

        const currentIndex = VALID_BENTUK.indexOf(bentukBerikutnya);
        let progressPercent = 0;
        if (isCustom) {
          progressPercent = totalEstimasi > 0 ? Math.min(100, Math.round((totalSynced / totalEstimasi) * 100)) : 0;
        } else {
          progressPercent = Math.max(0, Math.round((currentIndex / VALID_BENTUK.length) * 100));
        }

        const selesai = isCustom ? (bentukBerikutnya === 'Selesai') : (bentukBerikutnya === 'tk' && offsetBerikutnya === 0 && activeRow.waktu_selesai_terakhir !== null && progressPercent === 0);

        if (selesai) {
          progressPercent = 100;
        }

        let activeProvince = null;
        if (activeRow.bentuk_aktif) {
          const match = activeRow.bentuk_aktif.match(/\((.*?)\)/);
          if (match) activeProvince = match[1];
        }

        let isRunning = false;
        if (activeRow.updated_at && !selesai) {
          const lastUpdatedMs = parseDateMs(activeRow.updated_at);
          if (lastUpdatedMs > 0 && (Date.now() - lastUpdatedMs < 120 * 1000)) { // 120 detik (2 menit)
            isRunning = true;
          }
        }
        const isActive = isRunning;



        const provSyncMap = {};
        provStatusList.forEach(p => {
          if (p.terakhir_sukses) {
            provSyncMap[cleanName(p.nama_provinsi)] = getWibDate(p.terakhir_sukses);
          }
        });

        const compareMap = {};
        let compareHtml = '';
        let hasDiffGlobal = false;
        let lastChecked = 'Belum ada data';

        let sumTotalApi = 0;
        let sumTotalDb = 0;
        let sumApiDuplicates = 0;
        let sumAdjustedSelisih = 0;
        let diffCount = 0;

        if (compareCache) {
          lastChecked = formatWIB(compareCache.updated_at);
          compareCache.value.forEach(d => {
            const hasActualDiff = (d.selisih > 0 && !d.is_sinkron_walau_selisih);
            compareMap[d.nama.replace(/[^A-Z]/g, '')] = d.selisih;
            if (hasActualDiff) hasDiffGlobal = true;

            const isGap = (d.raw_selisih > 0) || ((d.total_api || 0) > (d.total_db || 0));
            const effDuplicates = isGap ? (d.api_duplicates || 0) : 0;

            sumTotalApi += d.total_api || 0;
            sumTotalDb += d.total_db || 0;
            sumApiDuplicates += effDuplicates;
            if (hasActualDiff) {
              sumAdjustedSelisih += d.selisih || 0;
              diffCount++;
            }
          });
          compareCache.value.sort((a, b) => {
            const aDiff = (a.selisih !== 0 || a.raw_selisih !== 0) ? 1 : 0;
            const bDiff = (b.selisih !== 0 || b.raw_selisih !== 0) ? 1 : 0;
            if (aDiff !== bDiff) return bDiff - aDiff;
            return a.nama.localeCompare(b.nama);
          });

          compareHtml = compareCache.value.map((d, idx) => {
            const todayDate = getWibDate();
            const isSyncedToday = Boolean(d.terakhir_sukses && getWibDate(d.terakhir_sukses) === todayDate);

            let selisihColor = 'var(--danger)';
            let statusIcon = '⚠️ Belum Sinkron';
            const extraInDb = (d.total_db || 0) - (d.total_api || 0);
            let selisihDisplay = `${d.selisih > 0 ? '+' : ''}${d.selisih.toLocaleString('id-ID')}`;

            if (d.raw_selisih === 0 && d.selisih === 0) {
              selisihColor = 'var(--success)';
              statusIcon = '✅ Sinkron';
              selisihDisplay = '0';
            } else if (d.selisih === 0 && (d.api_duplicates || 0) > 0) {
              selisihColor = 'var(--success)';
              statusIcon = '✅ Sinkron';
              selisihDisplay = '0';
            } else if (extraInDb > 0) {
              selisihColor = 'var(--warning)';
              statusIcon = '⚠️ Data Lebih di DB';
              selisihDisplay = `<span style="color: var(--warning);" title="Database memiliki ${extraInDb.toLocaleString('id-ID')} data sekolah lebih dibanding API Belajar.id">+${extraInDb.toLocaleString('id-ID')} di DB</span>`;
            } else if (d.selisih > 0) {
              selisihColor = isSyncedToday ? 'var(--warning)' : 'var(--danger)';
              statusIcon = isSyncedToday ? '⚠️ Sinkron Terputus' : '⚠️ Belum Sinkron';
              selisihDisplay = `+${d.selisih.toLocaleString('id-ID')}`;
            } else if (d.selisih < 0) {
              selisihColor = 'var(--warning)';
              statusIcon = '⚠️ Ada Selisih';
              selisihDisplay = `${d.selisih.toLocaleString('id-ID')}`;
            }

            const displayStyle = idx >= 5 ? 'display: none;' : '';
            const trClass = idx >= 5 ? 'hidden-row' : '';

            const isGap = (d.raw_selisih > 0) || ((d.total_api || 0) > (d.total_db || 0));
            const effDuplicates = isGap ? (d.api_duplicates || 0) : 0;
            const effEmptyNpsn = isGap ? (d.api_empty_npsn || 0) : 0;
            const effUnrecognizedShapes = isGap ? (d.api_unrecognized_shapes || 0) : 0;

            const warnings = [];
            if (effDuplicates > 0) warnings.push(`<span style="cursor: pointer; text-decoration: underline; color: var(--danger);" onclick="showDuplicateModal('${d.nama}')">⚠️ NPSN Ganda: ${effDuplicates}</span>`);
            if (effEmptyNpsn > 0) warnings.push(`⚠️ NPSN Kosong: ${effEmptyNpsn}`);
            if (effUnrecognizedShapes > 0) warnings.push(`⚠️ Bentuk Pendidikan Baru: ${effUnrecognizedShapes}`);

            // Fallback jika ada selisih yang belum teridentifikasi
            if (d.raw_selisih > 0 && effDuplicates === 0 && effEmptyNpsn === 0 && effUnrecognizedShapes === 0) {
              warnings.push(`⚠️ Indikasi Data Invalid / Sinkron Terputus: ${d.raw_selisih}`);
            }

            const warningHtml = warnings.length > 0 ? `<div style="font-size: 11px; font-weight: 600; color: var(--danger); margin-top: 6px; line-height: 1.4;">${warnings.join('<br>')}</div>` : '';

            return `
                <tr class="${trClass}" style="border-bottom: 1px solid var(--border); ${displayStyle}">
                  <td style="padding: 12px 8px; font-weight: 600; color: var(--text);">${d.nama} <div style="font-size: 11px; color: var(--text-muted); font-weight: normal; margin-top: 4px;">Kode: ${d.kode}</div></td>
                  <td style="padding: 12px 8px; text-align: center; color: var(--info); font-weight: 600; font-size: 14px;">
                    ${d.total_api.toLocaleString('id-ID')}
                    ${warningHtml}
                  </td>
                  <td style="padding: 12px 8px; text-align: center; color: var(--primary-light); font-weight: 600; font-size: 14px;">
                    ${d.total_db.toLocaleString('id-ID')}
                  </td>
                  <td style="padding: 12px 8px; text-align: center; color: ${selisihColor}; font-weight: bold; font-size: 14px;">${selisihDisplay}</td>
                  <td style="padding: 12px 8px; text-align: center; color: ${selisihColor}; font-size: 12px; font-weight: 600;">${statusIcon}</td>
                </tr>
              `;
          }).join('');
          if (hasDiffGlobal) {
            compareHtml += '<tr class="hidden-row" style="display: none;"><td colspan="5" style="padding: 16px; text-align: center;"><div style="color: var(--text-muted); font-size: 12px; margin-bottom: 8px;">Ada data yang berbeda. Smart Sync akan otomatis memprioritaskan provinsi yang berselisih saja.</div></td></tr>';
          }

          // Tambahkan baris total
          let totalSelisihHtml = '';
          if (sumApiDuplicates > 0 && sumAdjustedSelisih !== 0) {
            totalSelisihHtml = `
              <div style="color: var(--success); font-weight: bold;">+${sumApiDuplicates.toLocaleString('id-ID')} ✅</div>
              <div style="color: var(--danger); font-weight: bold; margin-top: 4px;">${sumAdjustedSelisih > 0 ? '+' : ''}${sumAdjustedSelisih.toLocaleString('id-ID')} ⚠️</div>
            `;
          } else if (sumApiDuplicates > 0) {
            totalSelisihHtml = `<div style="color: var(--success); font-weight: bold;">+${sumApiDuplicates.toLocaleString('id-ID')} ✅</div>`;
          } else if (sumAdjustedSelisih !== 0) {
            totalSelisihHtml = `<div style="color: var(--danger); font-weight: bold;">${sumAdjustedSelisih > 0 ? '+' : ''}${sumAdjustedSelisih.toLocaleString('id-ID')} ⚠️</div>`;
          } else {
            totalSelisihHtml = `<div style="color: var(--success); font-weight: bold;">0</div>`;
          }

          compareHtml += `
             <tr class="hidden-row" style="display: none; border-top: 2px solid var(--border); font-weight: bold; background: rgba(0,0,0,0.03);">
               <td style="padding: 12px 8px; color: var(--text);">TOTAL KESELURUHAN</td>
               <td style="padding: 12px 8px; text-align: center; color: var(--info); font-size: 14px;">${sumTotalApi.toLocaleString('id-ID')}</td>
               <td style="padding: 12px 8px; text-align: center; color: var(--primary-light); font-size: 14px;">${sumTotalDb.toLocaleString('id-ID')}</td>
               <td style="padding: 12px 8px; text-align: center; font-size: 14px; vertical-align: middle;">${totalSelisihHtml}</td>
               <td style="padding: 12px 8px; text-align: center; font-size: 12px;">${diffCount} Provinsi Berselisih</td>
             </tr>
           `;
        } else {
          compareHtml = '<tr><td colspan="5" style="text-align: center; padding: 20px; color: var(--text-muted);">Belum ada data perbandingan. Jalankan cron terlebih dahulu.</td></tr>';
        }

        const currentDayOfWeek = getWibDayOfWeek();
        const isMandatoryUpdateDay = (currentDayOfWeek === 3 || currentDayOfWeek === 4);

        const SCHEDULE = {
          3: ["JAWA TIMUR", "JAWA TENGAH", "BANTEN", "LAMPUNG", "NUSA TENGGARA TIMUR", "RIAU", "SUMATERA BARAT", "DKI JAKARTA", "JAMBI", "DI YOGYAKARTA", "SULAWESI TENGGARA", "SULAWESI UTARA", "MALUKU", "MALUKU UTARA", "KEPULAUAN RIAU", "KEPULAUAN BANGKA BELITUNG", "PAPUA PEGUNUNGAN", "PAPUA TENGAH", "PAPUA BARAT DAYA", "LUAR NEGERI"],
          4: ["JAWA BARAT", "SUMATERA UTARA", "SULAWESI SELATAN", "SUMATERA SELATAN", "NUSA TENGGARA BARAT", "ACEH", "KALIMANTAN BARAT", "KALIMANTAN SELATAN", "SULAWESI TENGAH", "KALIMANTAN TENGAH", "KALIMANTAN TIMUR", "BALI", "BENGKULU", "SULAWESI BARAT", "GORONTALO", "PAPUA", "KALIMANTAN UTARA", "PAPUA BARAT", "PAPUA SELATAN"]
        };
        const nextDayOfWeek = (currentDayOfWeek === 3) ? 4 : null; // Jika Rabu(3), besok(Kamis 4). Kamis tidak punya besok Full Sync.
        const todaySchedule = SCHEDULE[currentDayOfWeek] || [];
        const tomorrowSchedule = nextDayOfWeek ? SCHEDULE[nextDayOfWeek] : [];

        const tomorrowDayOfWeek = (currentDayOfWeek % 7) + 1;
        const isTomorrowMandatory = (tomorrowDayOfWeek === 3 || tomorrowDayOfWeek === 4);
        const tomorrowScheduleList = SCHEDULE[tomorrowDayOfWeek] || [];

        const todayDateWIB = getWibDate();
        const yesterdayDateWIB = getWibDate(Date.now() - 24 * 60 * 60 * 1000);
        const diffData = compareCache && compareCache.value ? compareCache.value.filter(d => {
          const syncedDate = provSyncMap[cleanName(d.nama)];
          d.isSyncedToday = syncedDate === todayDateWIB;
          d.isSyncedRecently = syncedDate === todayDateWIB || syncedDate === yesterdayDateWIB;

          const hasDiff = Math.abs(d.selisih) > 0 && !d.is_sinkron_walau_selisih;

          // Jika sedang disinkronkan saat ini, selalu sertakan dalam antrean
          if (activeProvince && cleanName(activeProvince) === cleanName(d.nama)) {
            return true;
          }

          // Jika sudah tersinkron hari ini dan TIDAK ada selisih, selalu sembunyikan
          if (d.isSyncedToday && !hasDiff) return false;

          if (isMandatoryUpdateDay) {
            // Pada hari wajib, tampilkan yang terjadwal (jika belum sinkron hari ini)
            if (todaySchedule.includes(d.nama) && !d.isSyncedToday) return true;
            if (tomorrowSchedule.includes(d.nama)) return true;
            
            // Selain itu, tampilkan HANYA jika ada selisih (untuk antre besok)
            if (hasDiff) return true;
            return false;
          } else {
            // Pada hari biasa, jika tidak ada selisih, sembunyikan
            if (!hasDiff) return false;

            // Jika ada selisih tapi sudah disinkron hari ini, tetap tampilkan (dengan status Smart Sync Besok)
            // Jadi tidak perlu difilter meskipun d.isSyncedToday true
            return true;
          }
        }) : [];

        // Pastikan provinsi yang sedang aktif disinkronkan selalu muncul di tabel antrean
        if (activeProvince && !diffData.some(d => cleanName(d.nama) === cleanName(activeProvince))) {
          diffData.unshift({
            nama: activeProvince,
            total_api: totalEstimasi || 0,
            total_db: totalSynced || 0,
            selisih: (totalEstimasi - totalSynced) || 0,
            isSyncedToday: false,
            isSyncedRecently: false
          });
        }

        if (isMandatoryUpdateDay) {
          diffData.sort((a, b) => {
            const aIsToday = todaySchedule.includes(a.nama);
            const bIsToday = todaySchedule.includes(b.nama);
            if (aIsToday && !bIsToday) return -1;
            if (!aIsToday && bIsToday) return 1;
            if (aIsToday && bIsToday) return todaySchedule.indexOf(a.nama) - todaySchedule.indexOf(b.nama);
            
            if (currentDayOfWeek === 3) {
              const aIsTomorrow = tomorrowSchedule.includes(a.nama);
              const bIsTomorrow = tomorrowSchedule.includes(b.nama);
              if (aIsTomorrow && !bIsTomorrow) return -1;
              if (!aIsTomorrow && bIsTomorrow) return 1;
              if (aIsTomorrow && bIsTomorrow) return tomorrowSchedule.indexOf(a.nama) - tomorrowSchedule.indexOf(b.nama);
            }

            const aHasSynced = a.terakhir_sukses ? 1 : 0;
            const bHasSynced = b.terakhir_sukses ? 1 : 0;
            if (aHasSynced !== bHasSynced) return aHasSynced - bHasSynced;
            const maxDiffA = Math.abs(a.selisih);
            const maxDiffB = Math.abs(b.selisih);
            return maxDiffB - maxDiffA;
          });
        } else if (isTomorrowMandatory) {
          diffData.sort((a, b) => {
            // Urutkan yang masuk kategori "hari ini" (punya selisih & belum sync hari ini) di awal
            const aIsToday = !a.isSyncedToday && (Math.abs(a.selisih) > 0 && !a.is_sinkron_walau_selisih);
            const bIsToday = !b.isSyncedToday && (Math.abs(b.selisih) > 0 && !b.is_sinkron_walau_selisih);

            if (aIsToday && !bIsToday) return -1;
            if (!aIsToday && bIsToday) return 1;

            if (aIsToday && bIsToday) {
              const aHasSynced = a.terakhir_sukses ? 1 : 0;
              const bHasSynced = b.terakhir_sukses ? 1 : 0;
              if (aHasSynced !== bHasSynced) return aHasSynced - bHasSynced;

              if (aHasSynced && bHasSynced) {
                const timeA = new Date(a.terakhir_sukses).getTime();
                const timeB = new Date(b.terakhir_sukses).getTime();
                if (timeA !== timeB) return timeA - timeB;
              }
              const maxDiffA = Math.abs(a.selisih);
              const maxDiffB = Math.abs(b.selisih);
              return maxDiffB - maxDiffA;
            }

            // Kategori "besok" (Full Sync besok)
            const aIndex = tomorrowScheduleList.indexOf(a.nama);
            const bIndex = tomorrowScheduleList.indexOf(b.nama);
            return aIndex - bIndex;
          });
        } else {
          diffData.sort((a, b) => {
            const aHasSynced = a.terakhir_sukses ? 1 : 0;
            const bHasSynced = b.terakhir_sukses ? 1 : 0;

            if (aHasSynced !== bHasSynced) {
              return aHasSynced - bHasSynced; // 0 (belum sinkron) duluan
            }

            const aIsDifferent = (Math.abs(a.selisih) > 0 && !a.is_sinkron_walau_selisih) ? 1 : 0;
            const bIsDifferent = (Math.abs(b.selisih) > 0 && !b.is_sinkron_walau_selisih) ? 1 : 0;

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

        // Posisikan provinsi yang sedang aktif disinkronkan di urutan teratas antrean (#1)
        if (activeProvince) {
          const cleanActive = cleanName(activeProvince);
          diffData.sort((a, b) => {
            const aActive = cleanName(a.nama) === cleanActive ? 1 : 0;
            const bActive = cleanName(b.nama) === cleanActive ? 1 : 0;
            return bActive - aActive;
          });
        }

        const scheduledTodayTotal = (isMandatoryUpdateDay && SCHEDULE[currentDayOfWeek])
          ? SCHEDULE[currentDayOfWeek].reduce((sum, name) => {
              const p = compareCache?.value?.find(d => cleanName(d.nama) === cleanName(name));
              return sum + (p ? (p.total_api || 0) : 0);
            }, 0)
          : 0;
        const dynamicFullSyncLimit = Math.max(scheduledTodayTotal + 15000, 350000);
        const BATAS_AMAN = Math.max(100000, isMandatoryUpdateDay ? dynamicFullSyncLimit : 100000);
        let syncedToday = 0;
        try {
          const nowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
          const wibDateStr = nowWib.toISOString().split('T')[0];
          const startOfWibDayUtc = new Date(`${wibDateStr}T00:00:00+07:00`).toISOString();

          const { data: logs } = await supabase
            .from('log_aktivitas_provinsi')
            .select('total_baru, total_diperbarui, total_tidak_berubah')
            .gte('waktu_selesai', startOfWibDayUtc);
          const t = (logs || []).reduce((a, l) => a + (l.total_baru || 0) + (l.total_diperbarui || 0) + (l.total_tidak_berubah || 0), 0);
          syncedToday = t;
        } catch (e) { }

        if (isCustom && activeRow.updated_at) {
          const updatedAt = parseDateMs(activeRow.updated_at);
          if (updatedAt > 0 && (Date.now() - updatedAt < 5 * 60000)) {
            const currentRunning = (activeRow.total_baru || 0) + (activeRow.total_diperbarui || 0) + (activeRow.total_tidak_berubah || 0);
            syncedToday += currentRunning;
          }
        }
        const SISA_KUOTA = Math.max(0, BATAS_AMAN - syncedToday);
        let runningTotalEstimasi = 0;

        let bannerHtml = '';
        if (isMandatoryUpdateDay) {
          bannerHtml = `
            <div class="banner-box mandatory">
              <div class="banner-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
              </div>
              <div>
                <strong style="color: var(--primary-light); font-size: 14px;">Hari Sinkronisasi Penuh Aktif!</strong>
                <div style="font-size: 13px; margin-top: 4px; color: var(--text-muted); line-height: 1.4;">
                  Setiap Rabu dan Kamis, sistem memperbarui seluruh provinsi sesuai grup tanpa mengecek perbedaan. Hari ini: <strong style="color: #cbd5e1;">${currentDayOfWeek === 3 ? 'Grup 1 (Rabu)' : 'Grup 2 (Kamis)'}</strong>.
                </div>
              </div>
            </div>
          `;
        } else {
          bannerHtml = `
            <div class="banner-box smart">
              <div class="banner-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 01-2 2h-4a2 2 0 01-2-2v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>
              </div>
              <div>
                <strong style="color: #34d399; font-size: 14px;">Mode Smart Sync Aktif!</strong>
                <div style="font-size: 13px; margin-top: 4px; color: var(--text-muted); line-height: 1.4;">
                  Di luar hari Rabu dan Kamis, sistem secara otomatis menarik data untuk provinsi yang mendeteksi perbedaan secara cerdas.
                </div>
              </div>
            </div>
          `;
        }

        const queueHtml = `
          <div id="queue-container">
          ${bannerHtml}
          <h2 class="section-title">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="url(#queue-title-grad)" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
            Antrean Smart Sync (Otomatis)
          </h2>
          <div class="table-card-wrapper">
            <div class="info-notice-bar">
              Sistem secara cerdas mendeteksi provinsi mana yang butuh pembaruan. Provinsi dengan data tidak sinkron akan diprioritaskan, sedangkan yang sudah tersinkron namun berbeda akan digilir ke akhir antrean. 
              Maksimal <strong>~${BATAS_AMAN.toLocaleString('id-ID')} data</strong> disinkronisasi setiap harinya.
              <div style="margin-top: 8px; font-weight: 600;">
                Kuota Harian Digunakan: <span id="kuota-used-val" style="color: ${SISA_KUOTA <= 0 ? 'var(--danger)' : 'var(--warning)'}; font-weight: 700;">${syncedToday.toLocaleString('id-ID')} / ${BATAS_AMAN.toLocaleString('id-ID')}</span>
                <span id="kuota-full-tag">${SISA_KUOTA <= 0 ? '<span class="tag-alert-danger" style="margin-left: 6px;">KUOTA PENUH, SISA ANTREAN DITUNDA BESOK</span>' : ''}</span>
              </div>
            </div>
            <div id="queue-table-wrapper" style="overflow-x: auto;">
            <table class="custom-table">
              <thead>
                <tr>
                  <th style="text-align: left; width: 45px;">#</th>
                  <th style="text-align: left;">Provinsi</th>
                  <th style="text-align: center;">Estimasi Data</th>
                  <th style="text-align: center;">Selisih</th>
                  <th style="text-align: center;">Status Eksekusi</th>
                </tr>
              </thead>
              <tbody>
                 ${diffData.length === 0 ? `
                  <tr><td colspan="5" style="padding: 28px; text-align: center; color: #34d399; font-weight: 600;">
                    <div style="display: flex; align-items: center; justify-content: center; gap: 8px;">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                      Semua provinsi sudah sinkron sepenuhnya!
                    </div>
                  </td></tr>
                ` : (() => {
                  let daysSim = [{ offset: 0, used: syncedToday, limit: BATAS_AMAN, items: 0 }];
                  let queueCounters = {};

                  const assignedList = diffData.map((d) => {
                    const isThisProvActive = Boolean(isActive && activeProvince && cleanName(activeProvince) === cleanName(d.nama));
                    
                    if (isThisProvActive) {
                      return {
                        ...d,
                        assignedDayOffset: 0,
                        queueNumber: 0,
                        isThisProvActive: true
                      };
                    }

                    let assignedDayOffset = -1;
                    let assigned = false;
                    let minOffset = d.isSyncedToday ? 1 : 0;

                    for (let j = 0; j < daysSim.length; j++) {
                      let day = daysSim[j];
                      if (day.offset < minOffset) continue;
                      
                      if (day.used + (d.total_api || 0) <= day.limit) {
                        day.used += (d.total_api || 0);
                        day.items++;
                        assignedDayOffset = day.offset;
                        assigned = true;
                        break;
                      } else if (day.items === 0 && day.used === 0) {
                        day.used += (d.total_api || 0);
                        day.items++;
                        assignedDayOffset = day.offset;
                        assigned = true;
                        break;
                      }
                    }

                    if (!assigned) {
                      let newOffset = Math.max(minOffset, daysSim[daysSim.length - 1].offset + 1);
                      const nextDaySimulated = (currentDayOfWeek + newOffset - 1) % 7 + 1;
                      const isNextDayMandatory = (nextDaySimulated === 3 || nextDaySimulated === 4);
                      let nextDayScheduledTotal = (isNextDayMandatory && SCHEDULE[nextDaySimulated])
                        ? SCHEDULE[nextDaySimulated].reduce((sum, name) => {
                            const p = compareCache?.value?.find(item => cleanName(item.nama) === cleanName(name));
                            return sum + (p ? (p.total_api || 0) : 0);
                          }, 0)
                        : 0;
                      let newLimit = isNextDayMandatory ? Math.max(nextDayScheduledTotal + 15000, 350000) : 100000;
                      
                      let newDay = { offset: newOffset, used: (d.total_api || 0), limit: newLimit, items: 1 };
                      daysSim.push(newDay);
                      daysSim.sort((a,b) => a.offset - b.offset);
                      assignedDayOffset = newOffset;
                    }

                    queueCounters[assignedDayOffset] = (queueCounters[assignedDayOffset] || 0) + 1;
                    const queueNumber = queueCounters[assignedDayOffset];

                    return {
                      ...d,
                      assignedDayOffset,
                      queueNumber,
                      isThisProvActive: false
                    };
                  });

                  // Urutkan antrean:
                  // 1. Yang aktif menyinkronkan selalu di urutan paling atas (#1 / ⚡)
                  // 2. Berdasarkan harinya secara kronologis (assignedDayOffset: 0 (Hari Ini) -> 1 (Besok) -> 2 (Lusa) dst)
                  // 3. Di dalam hari yang sama, urutkan berdasarkan nomor antrean di hari tersebut (queueNumber: #1, #2, #3 dst)
                  assignedList.sort((a, b) => {
                    if (a.isThisProvActive && !b.isThisProvActive) return -1;
                    if (!a.isThisProvActive && b.isThisProvActive) return 1;

                    if (a.assignedDayOffset !== b.assignedDayOffset) {
                      return a.assignedDayOffset - b.assignedDayOffset;
                    }

                    return a.queueNumber - b.queueNumber;
                  });

                  return assignedList.map((d, i) => {
                    let statusLabel = '';
                    let rowClass = '';

                    if (d.isThisProvActive) {
                      statusLabel = '<span class="status-pill active-sync"><svg class="spin-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> Sedang Menyinkronkan</span>';
                      rowClass = 'row-active';
                    } else {
                      if (d.assignedDayOffset === 0) {
                        if (isMandatoryUpdateDay && todaySchedule.includes(d.nama)) {
                          statusLabel = `<span class="status-pill pending">Antrian ke #${d.queueNumber}</span>`;
                        } else {
                          statusLabel = `<span class="status-pill pending">Dieksekusi Hari Ini #${d.queueNumber}</span>`;
                        }
                      } else {
                        const scheduledDayOfWeek = (currentDayOfWeek + d.assignedDayOffset - 1) % 7 + 1;
                        const isScheduledMandatory = (scheduledDayOfWeek === 3 || scheduledDayOfWeek === 4);
                        const dayNameMap = {1: 'Senin', 2: 'Selasa', 3: 'Rabu', 4: 'Kamis', 5: "Jum'at", 6: 'Sabtu', 7: 'Minggu'};
                        const scheduledDayName = dayNameMap[scheduledDayOfWeek];
                        
                        if (isScheduledMandatory) {
                          statusLabel = `<span class="status-pill muted">Full Sync (${scheduledDayName}) #${d.queueNumber}</span>`;
                        } else {
                          statusLabel = `<span class="status-pill muted">Smart Sync (${scheduledDayName}) #${d.queueNumber}</span>`;
                        }
                      }
                    }

                    let selisihColor = 'var(--danger)';
                    const extraInDbQueue = (d.total_db || 0) - (d.total_api || 0);
                    let selisihVal = `${d.selisih > 0 ? '+' : ''}${d.selisih.toLocaleString('id-ID')}`;

                    if (d.selisih === 0) {
                      selisihColor = 'var(--success)';
                      selisihVal = '0';
                    } else if (extraInDbQueue > 0 && d.is_sinkron_walau_selisih) {
                      selisihColor = 'var(--success)';
                      selisihVal = `+${extraInDbQueue.toLocaleString('id-ID')} di DB`;
                    } else if (d.is_sinkron_walau_selisih) {
                      selisihColor = 'var(--success)';
                      selisihVal = '0';
                    }

                    return `
                      <tr class="${rowClass}" data-prov="${cleanName(d.nama)}">
                        <td style="padding: 12px; text-align: left; font-weight: 700; color: var(--text-subtle); font-size: 13px;">
                          ${d.isThisProvActive ? '<span class="spin-icon" style="color: #818cf8; font-size: 14px;">⚡</span>' : (i + 1)}
                        </td>
                        <td style="padding: 12px; text-align: left; font-weight: 600; font-size: 14px;">
                          ${d.isThisProvActive ? `
                            <div style="display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                              <span class="active-prov-glow">${d.nama}</span>
                              <span class="badge-live-sync"><span class="pulse-dot-mini"></span> SEDANG SINKRON</span>
                            </div>
                          ` : `<span style="color: var(--text-main);">${d.nama}</span>`}
                        </td>
                        <td style="padding: 12px; text-align: center; color: var(--info); font-weight: 600; font-size: 14px;">${(d.total_api || 0).toLocaleString('id-ID')}</td>
                        <td style="padding: 12px; text-align: center; color: ${selisihColor}; font-weight: 700; font-size: 14px;">${selisihVal}</td>
                        <td style="padding: 12px; text-align: center; font-size: 13px;">${statusLabel}</td>
                      </tr>
                    `;
                  }).join('');
                })()}
              </tbody>
            </table>
            </div>
          </div>
          </div>
        `;

        // Fetch Log Aktivitas (Maksimal 5 data terbaru untuk tampilan dashboard)
        const limit = 5;
        let logAktivitasList = [];
        try {
          const { data: logRes } = await supabase
            .from('log_aktivitas_provinsi')
            .select('*')
            .order('waktu_selesai', { ascending: false })
            .limit(limit);
          logAktivitasList = logRes || [];
        } catch (e) {}

        const paginationHtml = '<div style="font-size: 11px; color: var(--text-muted); text-align: right; margin-top: 6px;">Menampilkan maksimal 5 aktivitas sinkronisasi terbaru</div>';

        const pStatusMap = new Map((provStatusList || []).map(p => [cleanName(p.nama_provinsi), p]));
        const compDataMap = new Map(((compareCache && compareCache.value) || []).map(c => [cleanName(c.nama), c]));

        let logHtml = logAktivitasList.length > 0 ? logAktivitasList.map(log => {
          const cName = cleanName(log.nama_provinsi);
          const pStat = pStatusMap.get(cName);
          const compItem = compDataMap.get(cName);

          const baseProcessed = (log.total_baru || 0) + (log.total_diperbarui || 0) + (log.total_tidak_berubah || 0);
          const targetTotal = (compItem?.total_db > 0 ? compItem.total_db : (compItem?.total_api || pStat?.total_db || 0));

          let nonQueryable = 0;
          if (targetTotal > baseProcessed) {
            const missing = targetTotal - baseProcessed;
            const knownNq = (typeof log.total_non_queryable === 'number' && log.total_non_queryable > 0)
              ? log.total_non_queryable
              : (pStat?.api_unrecognized_shapes || 0);

            if (knownNq > 0) {
              nonQueryable = Math.min(missing, knownNq);
            } else {
              nonQueryable = missing;
            }
          }

          const totalData = baseProcessed + nonQueryable;

          return `<div class="log-item-card">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
              <strong style="color: var(--text-main); font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 6px;">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--primary-light)" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                ${log.nama_provinsi}
              </strong>
              <span style="color: var(--text-muted); font-size: 12px; font-weight: 500; display: flex; align-items: center; gap: 4px;">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                ${formatWIB(log.waktu_selesai)}
              </span>
            </div>
            <div class="log-stats-grid">
              <div class="log-badge-mini success">+${(log.total_baru || 0).toLocaleString('id-ID')} Baru</div>
              <div class="log-badge-mini info">↻ ${(log.total_diperbarui || 0).toLocaleString('id-ID')} Update</div>
              <div class="log-badge-mini danger">✕ ${(log.total_dihapus || 0).toLocaleString('id-ID')} Hapus</div>
              <div class="log-badge-mini muted">✓ ${(log.total_tidak_berubah || 0).toLocaleString('id-ID')} Tetap</div>
              <div class="log-badge-mini ${nonQueryable > 0 ? 'special' : 'muted'}" title="${nonQueryable > 0 ? 'Bentuk pendidikan khusus / non-queryable di API kementerian' : 'Tidak ada data non-queryable'}">${nonQueryable > 0 ? '★ ' : ''}${nonQueryable.toLocaleString('id-ID')} Non-Queryable</div>
            </div>
            <div style="text-align: left; margin-top: 10px; font-weight: 700; font-size: 13px; color: var(--text-subtle); border-top: 1px solid rgba(255,255,255,0.06); padding-top: 10px; display: flex; justify-content: space-between;">
              <span>Total Processed</span>
              <span style="color: var(--primary-light);">${totalData.toLocaleString('id-ID')} Data</span>
            </div>
          </div>`;
        }).join('') : '<div style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 20px;">Belum ada log aktivitas.</div>';

        let activeNonQueryable = 0;
        if (activeProvince) {
          const cName = cleanName(activeProvince);
          const pStat = pStatusMap.get(cName);
          const compItem = compDataMap.get(cName);
          if (pStat && typeof pStat.api_unrecognized_shapes === 'number' && pStat.api_unrecognized_shapes > 0) {
            activeNonQueryable = pStat.api_unrecognized_shapes;
          } else if (compItem && typeof compItem.api_unrecognized_shapes === 'number') {
            activeNonQueryable = compItem.api_unrecognized_shapes;
          }
        } else if (logAktivitasList && logAktivitasList.length > 0) {
          const latestLog = logAktivitasList[0];
          if (typeof latestLog.total_non_queryable === 'number' && latestLog.total_non_queryable > 0) {
            activeNonQueryable = latestLog.total_non_queryable;
          } else {
            const cName = cleanName(latestLog.nama_provinsi);
            const pStat = pStatusMap.get(cName);
            const compItem = compDataMap.get(cName);
            if (pStat && typeof pStat.api_unrecognized_shapes === 'number' && pStat.api_unrecognized_shapes > 0) {
              activeNonQueryable = pStat.api_unrecognized_shapes;
            } else if (compItem && typeof compItem.api_unrecognized_shapes === 'number') {
              activeNonQueryable = compItem.api_unrecognized_shapes;
            }
          }
        }

        const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sekolah Sync Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🔄</text></svg>">
  <style>
    :root {
      --bg-dark: #090d16;
      --card-bg: rgba(15, 23, 42, 0.78);
      --card-border: rgba(255, 255, 255, 0.1);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --text-subtle: #cbd5e1;
      --primary: #6366f1;
      --primary-light: #818cf8;
      --primary-glow: rgba(99, 102, 241, 0.25);
      --success: #10b981;
      --info: #06b6d4;
      --danger: #f43f5e;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; }
    body {
      font-family: 'Plus Jakarta Sans', 'Inter', -apple-system, sans-serif;
      background: var(--bg-dark);
      background-image: 
        radial-gradient(at 0% 0%, rgba(99, 102, 241, 0.22) 0px, transparent 50%),
        radial-gradient(at 100% 0%, rgba(168, 85, 247, 0.18) 0px, transparent 50%),
        radial-gradient(at 50% 100%, rgba(16, 185, 129, 0.12) 0px, transparent 50%);
      background-attachment: fixed;
      color: var(--text-main);
      display: flex; justify-content: center; align-items: flex-start;
      min-height: 100vh; margin: 0; padding: 40px 16px;
    }
    
    .card {
      background: var(--card-bg);
      backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
      border: 1px solid var(--card-border); border-radius: 28px;
      padding: 36px 28px; width: 100%; max-width: 680px;
      box-shadow: 0 25px 60px -15px rgba(0, 0, 0, 0.7), 0 0 40px rgba(99, 102, 241, 0.12);
      text-align: center; margin: auto; position: relative; overflow: hidden;
    }

    .hero-title {
      margin-top: 8px; font-size: 26px; font-weight: 800;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, #ffffff 0%, #cbd5e1 50%, #818cf8 100%);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
      display: flex; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap;
    }

    .badge-tag {
      font-size: 12px; font-weight: 700; vertical-align: middle;
      padding: 4px 12px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.5px;
    }
    .badge-tag.custom {
      color: #fb923c; background: rgba(249, 115, 22, 0.15); border: 1px solid rgba(249, 115, 22, 0.3);
    }
    .badge-tag.full {
      color: #818cf8; background: rgba(99, 102, 241, 0.15); border: 1px solid rgba(99, 102, 241, 0.3);
    }

    .status-badge {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 8px 20px; border-radius: 9999px; font-size: 13px; font-weight: 700;
      letter-spacing: 0.3px;
      background: rgba(99, 102, 241, 0.15); color: #818cf8; margin-bottom: 20px;
      border: 1px solid rgba(99, 102, 241, 0.3);
      box-shadow: 0 0 20px rgba(99, 102, 241, 0.2);
      transition: all 0.3s;
    }
    .status-badge.finished {
      background: rgba(16, 185, 129, 0.15); color: #34d399;
      border-color: rgba(16, 185, 129, 0.3); box-shadow: 0 0 20px rgba(16, 185, 129, 0.2);
    }
    .status-badge.stopped {
      background: rgba(244, 63, 94, 0.15); color: #fb7185;
      border-color: rgba(244, 63, 94, 0.3); box-shadow: 0 0 20px rgba(244, 63, 94, 0.2);
    }

    .pulse-dot {
      width: 10px; height: 10px; border-radius: 50%; background: #818cf8;
      box-shadow: 0 0 0 0 rgba(129, 140, 248, 0.7);
      animation: pulse-ring 1.6s infinite;
    }
    @keyframes pulse-ring {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(129, 140, 248, 0.7); }
      70% { transform: scale(1); box-shadow: 0 0 0 8px rgba(129, 140, 248, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(129, 140, 248, 0); }
    }

    .loader-svg {
      margin: 0 auto 16px auto; display: block;
      filter: drop-shadow(0 0 12px rgba(99, 102, 241, 0.4));
    }
    
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; margin-top: 24px; }
    @media (min-width: 600px) {
      .grid { grid-template-columns: repeat(3, 1fr); }
    }
    @media (min-width: 860px) {
      .grid { grid-template-columns: repeat(5, 1fr); }
    }
    @media (max-width: 599px) {
      .grid .stat-box:last-child:nth-child(odd) {
        grid-column: span 2;
      }
    }
    
    .stat-box {
      background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 20px; padding: 18px 12px; transition: all 0.25s ease;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      position: relative; overflow: hidden;
    }
    .stat-box:hover {
      transform: translateY(-4px); background: rgba(255, 255, 255, 0.06);
      border-color: rgba(255, 255, 255, 0.18);
      box-shadow: 0 12px 25px rgba(0, 0, 0, 0.4);
    }
    .stat-icon-wrapper {
      width: 36px; height: 36px; border-radius: 12px;
      display: flex; align-items: center; justify-content: center; margin-bottom: 10px;
    }
    .stat-icon-wrapper.success { background: rgba(16, 185, 129, 0.15); color: #34d399; }
    .stat-icon-wrapper.info { background: rgba(6, 182, 212, 0.15); color: #38bdf8; }
    .stat-icon-wrapper.danger { background: rgba(244, 63, 94, 0.15); color: #fb7185; }
    .stat-icon-wrapper.subtle { background: rgba(148, 163, 184, 0.15); color: #cbd5e1; }
    .stat-icon-wrapper.special { background: rgba(168, 85, 247, 0.15); color: #c084fc; }

    .stat-val { font-size: 22px; font-weight: 800; color: var(--text-main); line-height: 1.1; }
    .stat-label { font-size: 12px; font-weight: 500; color: var(--text-muted); margin-top: 6px; }
    
    .progress-bar-container {
      max-width: 440px; margin: 0 auto 28px auto;
    }
    .progress-bar {
      height: 10px; background: rgba(255, 255, 255, 0.08); border-radius: 9999px;
      overflow: hidden; margin-top: 0; border: 1px solid rgba(255, 255, 255, 0.06);
      box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.4);
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #6366f1 0%, #a855f7 50%, #ec4899 100%);
      border-radius: 9999px; transition: width 0.5s ease;
      box-shadow: 0 0 15px rgba(99, 102, 241, 0.6);
    }

    .main-info-box {
      background: rgba(0, 0, 0, 0.25); border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 16px; padding: 14px 20px; font-size: 14px; color: var(--text-subtle);
      line-height: 1.6; margin-top: 16px; display: inline-block; width: 100%; text-align: left;
    }
    
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      margin-top: 28px; padding: 14px 28px;
      background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%);
      color: #ffffff; font-weight: 700; text-decoration: none; font-size: 14px;
      border-radius: 14px; transition: all 0.3s ease;
      box-shadow: 0 8px 25px rgba(99, 102, 241, 0.35); border: 1px solid rgba(255, 255, 255, 0.15);
    }
    .btn:hover {
      transform: translateY(-3px) scale(1.02);
      box-shadow: 0 14px 35px rgba(99, 102, 241, 0.5);
      background: linear-gradient(135deg, #4f46e5 0%, #9333ea 100%);
    }

    .banner-box {
      display: flex; gap: 14px; align-items: flex-start;
      padding: 14px 18px; border-radius: 16px; margin: 24px 0; text-align: left;
      border-left: 4px solid; backdrop-filter: blur(12px);
    }
    .banner-box.mandatory {
      background: rgba(99, 102, 241, 0.1); border-color: var(--primary);
    }
    .banner-box.smart {
      background: rgba(16, 185, 129, 0.1); border-color: var(--success);
    }
    .banner-icon { margin-top: 2px; }
    .banner-box.mandatory .banner-icon { color: var(--primary-light); }
    .banner-box.smart .banner-icon { color: #34d399; }

    .section-title {
      font-size: 17px; font-weight: 700; margin-bottom: 14px; color: var(--text-main);
      display: flex; align-items: center; gap: 8px; border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding-bottom: 10px; text-align: left;
    }

    .table-card-wrapper {
      background: rgba(0, 0, 0, 0.2); border: 1px solid var(--card-border);
      border-radius: 18px; overflow: hidden; margin-bottom: 24px; text-align: left;
    }
    .info-notice-bar {
      padding: 14px 18px; background: rgba(255, 255, 255, 0.02); font-size: 13px;
      color: var(--text-muted); border-bottom: 1px solid var(--card-border); line-height: 1.5;
    }

    .custom-table {
      width: 100%; min-width: 520px; border-collapse: collapse; font-size: 13px;
    }
    .custom-table thead tr {
      background: rgba(255, 255, 255, 0.04); color: var(--text-muted);
      text-transform: uppercase; font-size: 11px; font-weight: 700; letter-spacing: 0.6px;
      border-bottom: 1px solid var(--card-border);
    }
    .custom-table th { padding: 14px 12px; }
    .custom-table td { padding: 13px 12px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
    .custom-table tr:hover { background: rgba(255, 255, 255, 0.025); }
    .custom-table tr.row-active {
      background: linear-gradient(90deg, rgba(99, 102, 241, 0.16) 0%, rgba(236, 72, 153, 0.12) 50%, rgba(99, 102, 241, 0.16) 100%) !important;
      border-left: 3px solid #818cf8 !important;
      animation: rowPulseGlow 3s ease-in-out infinite alternate;
    }
    @keyframes rowPulseGlow {
      0% {
        background-color: rgba(99, 102, 241, 0.12);
        box-shadow: inset 0 0 14px rgba(99, 102, 241, 0.2);
      }
      100% {
        background-color: rgba(236, 72, 153, 0.18);
        box-shadow: inset 0 0 22px rgba(236, 72, 153, 0.3);
      }
    }
    .custom-table tr.row-active td {
      border-bottom: 1px solid rgba(129, 140, 248, 0.35) !important;
    }
    .badge-live-sync {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 7px;
      background: rgba(99, 102, 241, 0.25);
      border: 1px solid rgba(129, 140, 248, 0.5);
      border-radius: 6px;
      font-size: 10px;
      font-weight: 800;
      color: #a5b4fc;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      box-shadow: 0 0 10px rgba(99, 102, 241, 0.35);
    }
    .pulse-dot-mini {
      width: 7px;
      height: 7px;
      background-color: #38bdf8;
      border-radius: 50%;
      display: inline-block;
      box-shadow: 0 0 8px #38bdf8;
      animation: pulse-mini 1.2s infinite ease-in-out;
    }
    @keyframes pulse-mini {
      0%, 100% { transform: scale(0.85); opacity: 0.7; }
      50% { transform: scale(1.25); opacity: 1; box-shadow: 0 0 10px #38bdf8; }
    }
    .active-prov-glow {
      color: #ffffff;
      font-weight: 700;
      text-shadow: 0 0 12px rgba(129, 140, 248, 0.7);
    }

    .status-pill {
      display: inline-flex; align-items: center; justify-content: center; gap: 4px;
      padding: 4px 10px; border-radius: 9999px; font-size: 12px; font-weight: 700;
    }
    .status-pill.active-sync {
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.25), rgba(236, 72, 153, 0.25));
      color: #e0e7ff;
      border: 1px solid rgba(129, 140, 248, 0.5);
      box-shadow: 0 0 12px rgba(99, 102, 241, 0.3);
      padding: 5px 12px;
    }
    .status-pill.active-sync .spin-icon {
      color: #818cf8;
      filter: drop-shadow(0 0 4px #818cf8);
    }
    .status-pill.pending { background: rgba(245, 158, 11, 0.15); color: #fb923c; }
    .status-pill.muted { background: rgba(255, 255, 255, 0.06); color: var(--text-muted); }

    .tag-alert-danger {
      color: #fb7185; font-weight: 700; margin-left: 8px; font-size: 11px;
      background: rgba(244, 63, 94, 0.15); padding: 2px 8px; border-radius: 6px; border: 1px solid rgba(244, 63, 94, 0.3);
    }

    .log-item-card {
      background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.07);
      border-radius: 16px; padding: 14px; font-size: 13px; transition: border-color 0.2s;
    }
    .log-item-card:hover { border-color: rgba(99, 102, 241, 0.3); }

    .log-stats-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(75px, 1fr)); gap: 6px; text-align: center;
    }
    .log-badge-mini {
      padding: 4px 6px; border-radius: 8px; font-size: 11px; font-weight: 700;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .log-badge-mini.success { background: rgba(16, 185, 129, 0.12); color: #34d399; }
    .log-badge-mini.info { background: rgba(6, 182, 212, 0.12); color: #38bdf8; }
    .log-badge-mini.danger { background: rgba(244, 63, 94, 0.12); color: #fb7185; }
    .log-badge-mini.muted { background: rgba(255, 255, 255, 0.05); color: var(--text-muted); }
    .log-badge-mini.special {
      background: rgba(168, 85, 247, 0.15);
      color: #c084fc;
      border: 1px solid rgba(168, 85, 247, 0.3);
      box-shadow: 0 0 10px rgba(168, 85, 247, 0.15);
    }

    .pagination-wrapper {
      display: flex; justify-content: center; align-items: center; gap: 10px; margin-top: 18px;
    }
    .page-btn {
      padding: 7px 14px; background: rgba(255, 255, 255, 0.05); border: 1px solid var(--card-border);
      border-radius: 10px; color: var(--text-main); text-decoration: none; font-size: 13px; font-weight: 600;
      display: inline-flex; align-items: center; gap: 4px; transition: all 0.2s;
    }
    .page-btn:hover { background: rgba(99, 102, 241, 0.2); border-color: var(--primary); }
    .page-info { font-size: 13px; color: var(--text-muted); font-weight: 500; }

    .spin-icon { display: inline-block; animation: rotation 1.4s linear infinite; }
    @keyframes rotation { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    
    @media (max-width: 480px) {
      .card { padding: 24px 16px; border-radius: 20px; }
      .hero-title { font-size: 20px; }
      .grid { gap: 10px; }
      .stat-box { padding: 14px 8px; }
      .stat-val { font-size: 18px; }
      .log-stats-grid { grid-template-columns: repeat(2, 1fr); }
      .log-stats-grid .log-badge-mini:last-child:nth-child(odd) { grid-column: span 2; }
    }
  </style>
  <script>
    document.addEventListener("DOMContentLoaded", function() {
      // Restore window scroll
      const scrollPos = sessionStorage.getItem("scrollPos");
      if (scrollPos) {
        window.scrollTo(0, parseInt(scrollPos));
      }
      // Restore grid scroll
      const gridScrollPos = sessionStorage.getItem("gridScrollPos");
      const gridEl = document.querySelector(".jadwal-grid");
      if (gridEl) {
        if (gridScrollPos !== null) {
          gridEl.scrollTop = parseInt(gridScrollPos);
        } else {
          // Auto-focus to today's schedule on first load
          const todayCard = gridEl.querySelector('.day-card.today');
          if (todayCard) {
            const topPos = todayCard.offsetTop - gridEl.offsetTop;
            gridEl.scrollTop = topPos > 0 ? topPos : 0;
            sessionStorage.setItem("gridScrollPos", gridEl.scrollTop);
          }
        }
        
        // Save scroll position on manual scroll
        gridEl.addEventListener('scroll', function() {
          sessionStorage.setItem("gridScrollPos", gridEl.scrollTop);
        });
      }
      
      // Restore compare horizontal scroll
      const compareScrollPos = sessionStorage.getItem("compareScrollPos");
      const compareEl = document.getElementById("compare-container");
      if (compareScrollPos && compareEl) {
        compareEl.scrollLeft = parseInt(compareScrollPos);
      }
      
      // Restore show all compare
      const showAll = sessionStorage.getItem("compareShowAll");
      if (showAll === "true") {
         const rows = document.querySelectorAll('.hidden-row');
         const btn = document.getElementById('btn-compare');
         if (rows.length > 0 && btn) {
            rows.forEach(r => r.style.display = 'table-row');
            btn.innerText = 'Tutup Perbandingan';
         }
      }
    });
    
    function toggleComparison() {
      const rows = document.querySelectorAll('.hidden-row');
      const btn = document.getElementById('btn-compare');
      let isHidden = true;
      
      if (rows.length > 0) {
        isHidden = rows[0].style.display === 'none';
        rows.forEach(r => {
           r.style.display = isHidden ? 'table-row' : 'none';
        });
        btn.innerText = isHidden ? 'Tutup Perbandingan' : 'Tampilkan Semua';
        sessionStorage.setItem('compareShowAll', isHidden ? 'true' : 'false');
      }
    }

    async function changeLogPage(page) {
      try {
        window.isAutoReloadPaused = true;
        const url = new URL(window.location.href);
        url.searchParams.set('page', page);
        url.searchParams.set('_t', new Date().getTime());
        
        const res = await fetch(url.toString(), { cache: 'no-store' });
        const html = await res.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        const newLogContainer = doc.getElementById('log-container');
        const currentLogContainer = document.getElementById('log-container');
        if (newLogContainer && currentLogContainer) {
          currentLogContainer.innerHTML = newLogContainer.innerHTML;
        }

        const newPagination = doc.getElementById('log-pagination');
        const currentPaginationWrapper = document.getElementById('log-pagination-wrapper');
        if (currentPaginationWrapper) {
          currentPaginationWrapper.innerHTML = newPagination ? newPagination.outerHTML : '';
        }
        
        window.history.pushState({}, '', url.toString());
      } catch(e) {
        console.error("Gagal mengganti halaman log", e);
      } finally {
        window.isAutoReloadPaused = false;
      }
    }

    let lastKnownState = null;
    let autoReloadTimer = null;

    function scheduleNextReload(delay) {
      if (autoReloadTimer) clearTimeout(autoReloadTimer);
      autoReloadTimer = setTimeout(doAutoReload, delay);
    }

    async function fetchFullHtml() {
      try {
        const isShowAll = sessionStorage.getItem("compareShowAll") === "true";
        const currentUrl = new URL(window.location.href);
        currentUrl.searchParams.set('_t', new Date().getTime());

        const res = await fetch(currentUrl.toString(), { cache: 'no-store' });
        const html = await res.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        if (!doc) return;

        const jadwalGrid = document.querySelector('.jadwal-grid');
        const newJadwalGrid = doc.querySelector('.jadwal-grid');
        if (jadwalGrid && newJadwalGrid) {
          const currentScroll = jadwalGrid.scrollTop;
          jadwalGrid.innerHTML = newJadwalGrid.innerHTML;
          jadwalGrid.scrollTop = currentScroll;
        }

        const logContainer = document.getElementById('log-container');
        const newLogContainer = doc.getElementById('log-container');
        if (logContainer && newLogContainer) logContainer.innerHTML = newLogContainer.innerHTML;

        const logPagination = document.getElementById('log-pagination-wrapper');
        const newLogPagination = doc.getElementById('log-pagination-wrapper');
        if (logPagination && newLogPagination) logPagination.innerHTML = newLogPagination.innerHTML;

        const compareBody = document.getElementById('compare-body');
        const newCompareBody = doc.getElementById('compare-body');
        if (compareBody && newCompareBody) {
          if (isShowAll) {
            const newRows = newCompareBody.querySelectorAll('.hidden-row');
            newRows.forEach(r => r.style.display = 'table-row');
          }
          compareBody.innerHTML = newCompareBody.innerHTML;
        }

        const lastChecked = document.getElementById('compare-last-checked');
        const newLastChecked = doc.getElementById('compare-last-checked');
        if (lastChecked && newLastChecked) lastChecked.innerHTML = newLastChecked.innerHTML;

        const queueContainer = document.getElementById('queue-container');
        const newQueueContainer = doc.getElementById('queue-container');
        if (queueContainer && newQueueContainer) {
          const queueWrapper = queueContainer.querySelector('#queue-table-wrapper');
          const currentScrollX = queueWrapper ? queueWrapper.scrollLeft : 0;
          queueContainer.innerHTML = newQueueContainer.innerHTML;
          const newQueueWrapper = queueContainer.querySelector('#queue-table-wrapper');
          if (newQueueWrapper) newQueueWrapper.scrollLeft = currentScrollX;
        }
      } catch (err) {
        console.error("Gagal memuat ulang data penuh:", err);
      }
    }

    function formatWIBClient(dStr) {
      if (!dStr) return '-';
      if (typeof dStr === 'string' && dStr.includes('WIB')) return dStr;
      var s = String(dStr).trim();
      var ms = NaN;
      if (s.includes('Z') || s.includes('+') || /T.*[+-]\d{2}/.test(s)) {
        ms = new Date(s).getTime();
      } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) {
        ms = new Date(s.replace(' ', 'T') + 'Z').getTime();
      } else {
        ms = new Date(s).getTime();
      }
      if (isNaN(ms) || !ms) return dStr;
      var d = new Date(ms + 7 * 3600 * 1000);
      var pad = function(n) { return String(n).padStart(2, '0'); };
      var D = pad(d.getUTCDate());
      var M = pad(d.getUTCMonth() + 1);
      var Y = d.getUTCFullYear();
      var h = pad(d.getUTCHours());
      var m = pad(d.getUTCMinutes());
      return D + '-' + M + '-' + Y + ' ' + h + ':' + m + ' WIB';
    }

    function updateDashboardUI(status) {
      if (!status) return;

      // 1. Update loader icon
      const loaderIcon = document.getElementById('loader-icon');
      if (loaderIcon) {
        loaderIcon.style.display = (status.isRunning && !status.selesai) ? 'block' : 'none';
      }

      // 2. Update status badge
      const statusBadge = document.getElementById('status');
      if (statusBadge) {
        if (status.selesai) {
          statusBadge.className = 'status-badge finished';
          statusBadge.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> Sinkronisasi Selesai';
        } else if (status.isRunning) {
          statusBadge.className = 'status-badge';
          var pName = status.activeProvince || (status.bentukBerikutnya && status.bentukBerikutnya.match(/\\((.*?)\\)/)?.[1]);
          statusBadge.innerHTML = '<span class="pulse-dot"></span> Sedang Menyinkronkan ' + (pName ? '— <strong>' + pName + '</strong>' : '') + '...';
        } else {
          statusBadge.className = 'status-badge stopped';
          statusBadge.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> Menunggu / Terhenti';
        }
      }

      // 3. Update progress bar & text
      const progFill = document.querySelector('.progress-fill');
      if (progFill) {
        progFill.style.width = (status.selesai ? 100 : status.progressPercent) + '%';
      }
      const progStats = document.getElementById('progress-stats');
      if (progStats) {
        const syncedFormatted = Number(status.totalSynced || 0).toLocaleString('id-ID');
        const estimasiFormatted = Number(status.totalEstimasi || 0).toLocaleString('id-ID');
        progStats.innerHTML = '<span>' + (status.progressPercent || 0) + '% Selesai</span><span>Data: ' + syncedFormatted + ' / ' + estimasiFormatted + '</span>';
      }

      // 4. Update stat boxes
      const statBaru = document.getElementById('stat-baru');
      if (statBaru) statBaru.innerText = Number(status.activeRow?.total_baru || 0).toLocaleString('id-ID');
      const statDiperbarui = document.getElementById('stat-diperbarui');
      if (statDiperbarui) statDiperbarui.innerText = Number(status.activeRow?.total_diperbarui || 0).toLocaleString('id-ID');
      const statDihapus = document.getElementById('stat-dihapus');
      if (statDihapus) statDihapus.innerText = Number(status.activeRow?.total_dihapus || 0).toLocaleString('id-ID');
      const statTidakBerubah = document.getElementById('stat-tidak-berubah');
      if (statTidakBerubah) statTidakBerubah.innerText = Number(status.activeRow?.total_tidak_berubah || 0).toLocaleString('id-ID');
      const statNonQueryable = document.getElementById('stat-non-queryable');
      if (statNonQueryable && status.total_non_queryable !== undefined) {
        statNonQueryable.innerText = Number(status.total_non_queryable).toLocaleString('id-ID');
      }

      // 5. Update info box
      const mainInfo = document.getElementById('main-info');
      if (mainInfo) {
        var pName = status.activeProvince || (status.bentukBerikutnya && status.bentukBerikutnya.match(/\\((.*?)\\)/)?.[1]);
        mainInfo.innerHTML = '<div style="display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px;">' +
          '<span>Bentuk Aktif: <strong style="color: var(--primary-light); text-transform: uppercase;">' + (status.bentukBerikutnya || '-') + '</strong></span>' +
          '<span>Offset Saat Ini: <strong style="color: var(--text-main);">' + (status.offsetBerikutnya || 0) + '</strong></span>' +
          '</div>' +
          '<div style="display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.06);">' +
          '<span>Provinsi Aktif: <strong style="color: #38bdf8; font-weight: 700;">' + (pName ? '📍 ' + pName : '🌐 Semua Wilayah') + '</strong></span>' +
          '<span style="font-size: 12px; color: var(--text-muted);">' +
          'Update Terakhir: <strong style="color: var(--text-subtle);">' + formatWIBClient(status.activeRow?.updated_at) + '</strong>' +
          '</span>' +
          '</div>';
      }

      // 6. Update Kuota Harian Digunakan secara realtime
      const kuotaUsedVal = document.getElementById('kuota-used-val');
      if (kuotaUsedVal && status.syncedToday !== undefined && status.batasAman !== undefined) {
        const isFull = (status.batasAman - status.syncedToday) <= 0;
        kuotaUsedVal.style.color = isFull ? 'var(--danger)' : 'var(--warning)';
        kuotaUsedVal.innerText = Number(status.syncedToday).toLocaleString('id-ID') + ' / ' + Number(status.batasAman).toLocaleString('id-ID');
        
        const kuotaFullTag = document.getElementById('kuota-full-tag');
        if (kuotaFullTag) {
          kuotaFullTag.innerHTML = isFull ? '<span class="tag-alert-danger" style="margin-left: 6px;">KUOTA PENUH, SISA ANTREAN DITUNDA BESOK</span>' : '';
        }
      }

      // 7. Update row aktif di Antrean Smart Sync secara dinamis
      const actProv = (status.isRunning && !status.selesai) ? (status.activeProvince || (status.bentukBerikutnya && status.bentukBerikutnya.match(/\\((.*?)\\)/)?.[1])) : null;
      const cleanAct = actProv ? actProv.replace(/[^A-Z0-9]/gi, '').toUpperCase().replace(/^PROVINSI|^PROV/, '') : null;
      const queueRows = document.querySelectorAll('.custom-table tbody tr[data-prov]');
      queueRows.forEach(tr => {
        const p = tr.getAttribute('data-prov');
        if (cleanAct && p === cleanAct) {
          tr.classList.add('row-active');
        } else {
          tr.classList.remove('row-active');
        }
      });
    }

    let isFetchingStatus = false;
    async function doAutoReload() {
      if (window.isAutoReloadPaused) {
        scheduleNextReload(5000);
        return;
      }

      if (document.hidden) {
        scheduleNextReload(10000);
        return;
      }

      if (isFetchingStatus) return;
      isFetchingStatus = true;

      try {
        const res = await fetch('/api/sync-status?_t=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) throw new Error('Status check failed');
        const status = await res.json();
        if (!status.ok) throw new Error(status.error || 'Unknown error');

        updateDashboardUI(status);

        // Jika terjadi transisi status atau provinsi berubah, perbarui tabel antrean & log penuh
        if (lastKnownState) {
          const stateChanged = (lastKnownState.selesai !== status.selesai) ||
                               (lastKnownState.bentukBerikutnya !== status.bentukBerikutnya) ||
                               (lastKnownState.isRunning !== status.isRunning) ||
                               (lastKnownState.activeProvince !== status.activeProvince) ||
                               (lastKnownState.activeRow?.total_dihapus !== status.activeRow?.total_dihapus);
          if (stateChanged) {
            await fetchFullHtml();
          }
        }
        lastKnownState = status;

        // Interval cepat: 2 detik saat aktif menyinkronkan, 5 detik saat menunggu
        const nextDelay = status.isRunning ? 2000 : 5000;
        scheduleNextReload(nextDelay);
      } catch (e) {
        scheduleNextReload(5000);
      } finally {
        isFetchingStatus = false;
      }
    }

    // Tangani perubahan visibilitas tab: aktifkan reload langsung saat tab dibuka kembali
    document.addEventListener('visibilitychange', function() {
      if (!document.hidden) {
        doAutoReload();
      }
    });

    // Inisialisasi Supabase Realtime untuk pembaruan tanpa jeda (WebSockets)
    const clientSupabaseUrl = "${clientSupabaseUrl}";
    const clientSupabaseAnonKey = "${clientSupabaseAnonKey}";

    if (window.supabase && clientSupabaseUrl && clientSupabaseAnonKey) {
      try {
        const sb = window.supabase.createClient(clientSupabaseUrl, clientSupabaseAnonKey);
        
        sb.channel('realtime-sync')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'status_sinkronisasi' }, function(payload) {
            doAutoReload();
          })
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'log_aktivitas_provinsi' }, function(payload) {
            doAutoReload();
            fetchFullHtml();
          })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'provinsi_sync_status' }, function(payload) {
            fetchFullHtml();
          })
          .subscribe();
      } catch (err) {
        console.warn("Supabase Realtime fallback to polling:", err);
      }
    }

    // Eksekusi pemeriksaan pertama langsung tanpa jeda (300ms setelah halaman dibuka)
    scheduleNextReload(300);
  </script>
</head>
<body>
  <div class="card">
    <!-- SVGs definition for shared gradients -->
    <svg width="0" height="0" style="position:absolute;">
      <defs>
        <linearGradient id="title-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#818cf8" />
          <stop offset="100%" stop-color="#c084fc" />
        </linearGradient>
        <linearGradient id="queue-title-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#38bdf8" />
          <stop offset="100%" stop-color="#818cf8" />
        </linearGradient>
      </defs>
    </svg>

    <!-- Animated Dual-Ring SVG Loader -->
    <svg id="loader-icon" class="loader-svg" width="52" height="52" viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg" style="${!isRunning || selesai ? 'display: none;' : ''}">
      <circle cx="26" cy="26" r="20" stroke="url(#loader-grad-1)" stroke-width="4" stroke-dasharray="75 35" stroke-linecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 26 26" to="360 26 26" dur="1.1s" repeatCount="indefinite"/>
      </circle>
      <circle cx="26" cy="26" r="13" stroke="#a855f7" stroke-width="3" stroke-dasharray="35 25" stroke-linecap="round" opacity="0.75">
        <animateTransform attributeName="transform" type="rotate" from="360 26 26" to="0 26 26" dur="1.7s" repeatCount="indefinite"/>
      </circle>
      <defs>
        <linearGradient id="loader-grad-1" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#6366f1" />
          <stop offset="100%" stop-color="#ec4899" />
        </linearGradient>
      </defs>
    </svg>
    
    <div id="status" class="status-badge ${selesai ? 'finished' : (!isRunning ? 'stopped' : '')}">
      ${selesai ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> Sinkronisasi Selesai' : (isRunning ? `<span class="pulse-dot"></span> Sedang Menyinkronkan ${activeProvince ? '— <strong>' + activeProvince + '</strong>' : ''}...` : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> Menunggu / Terhenti')}
    </div>
    
    <div class="progress-bar-container">
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${selesai ? 100 : progressPercent}%;"></div>
      </div>
      <div id="progress-stats" style="display: flex; justify-content: space-between; font-size: 13px; color: var(--text-muted); margin-top: 8px; font-weight: 600;">
        <span>${progressPercent}% Selesai</span>
        <span>Data: ${totalSynced.toLocaleString('id-ID')} / ${totalEstimasi.toLocaleString('id-ID')}</span>
      </div>
    </div>
    
    <h1 id="main-title" class="hero-title">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="url(#title-grad)" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
      Sekolah Sync Dashboard ${isCustom ? '<span class="badge-tag custom">Custom</span>' : '<span class="badge-tag full">Full</span>'}
    </h1>

    <div id="main-info" class="main-info-box">
      <div style="display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
        <span>Bentuk Aktif: <strong style="color: var(--primary-light); text-transform: uppercase;">${bentukBerikutnya}</strong></span>
        <span>Offset Saat Ini: <strong style="color: var(--text-main);">${offsetBerikutnya}</strong></span>
      </div>
      <div style="display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.06);">
        <span>Provinsi Aktif: <strong style="color: #38bdf8; font-weight: 700;">${activeProvince ? '📍 ' + activeProvince : '🌐 Semua Wilayah'}</strong></span>
        <span style="font-size: 12px; color: var(--text-muted);">
          Update Terakhir: <strong style="color: var(--text-subtle);">${formatWIB(activeRow.updated_at)}</strong>
        </span>
      </div>
    </div>

    <div class="grid">
      <div class="stat-box">
        <div class="stat-icon-wrapper success">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
        </div>
        <div id="stat-baru" class="stat-val" style="color: var(--success);">${activeRow.total_baru || 0}</div>
        <div class="stat-label">Baru Ditambahkan</div>
      </div>
      <div class="stat-box">
        <div class="stat-icon-wrapper info">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
        </div>
        <div id="stat-diperbarui" class="stat-val" style="color: var(--info);">${activeRow.total_diperbarui || 0}</div>
        <div class="stat-label">Diperbarui</div>
      </div>
      <div class="stat-box">
        <div class="stat-icon-wrapper danger">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
        </div>
        <div id="stat-dihapus" class="stat-val" style="color: var(--danger);">${activeRow.total_dihapus || 0}</div>
        <div class="stat-label">Dihapus (Nonaktif)</div>
      </div>
      <div class="stat-box">
        <div class="stat-icon-wrapper subtle">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
        </div>
        <div id="stat-tidak-berubah" class="stat-val">${activeRow.total_tidak_berubah || 0}</div>
        <div class="stat-label">Tidak Berubah</div>
      </div>
      <div class="stat-box">
        <div class="stat-icon-wrapper special">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/></svg>
        </div>
        <div id="stat-non-queryable" class="stat-val" style="color: #c084fc;">${(activeNonQueryable || 0).toLocaleString('id-ID')}</div>
        <div class="stat-label">Non-Queryable</div>
      </div>
    </div>
    
    ${queueHtml}
    
    <div style="margin-top: 32px; text-align: left;">
      <h2 class="section-title">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--primary-light)" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        Log Aktivitas Terakhir
      </h2>
      <div id="log-container" style="display: flex; flex-direction: column; gap: 10px;">
        ${logHtml}
      </div>
      <div id="log-pagination-wrapper">
        ${paginationHtml}
      </div>
    </div>

    <div style="margin-top: 36px; text-align: left;">
      <div id="compare-header-box" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--card-border); padding-bottom: 10px; margin-bottom: 16px;">
        <div>
          <h2 style="font-size: 17px; color: var(--text-main); font-weight: 700; margin: 0 0 4px 0; display: flex; align-items: center; gap: 8px;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>
            Perbandingan Data (Belajar.id vs DB)
          </h2>
          <div id="compare-last-checked" style="font-size: 12px; color: var(--text-muted);">Terakhir dicek: ${lastChecked}</div>
        </div>
        ${compareCache && compareCache.value.length > 5 ? `<button id="btn-compare" style="background: rgba(99, 102, 241, 0.2); color: var(--primary-light); border: 1px solid rgba(99, 102, 241, 0.4); padding: 8px 14px; border-radius: 10px; cursor: pointer; font-size: 12px; font-weight: 700; transition: all 0.2s; display: flex; align-items: center; gap: 6px;" onclick="toggleComparison()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg> Tampilkan Semua</button>` : ''}
      </div>
      <div id="compare-container" class="table-card-wrapper" style="overflow-x: auto;">
         <table id="compare-table" class="custom-table">
           <thead>
             <tr>
               <th style="padding: 14px 12px; text-align: left;">Provinsi</th>
               <th style="padding: 14px 12px; text-align: center;">Belajar.id</th>
               <th style="padding: 14px 12px; text-align: center;">Database</th>
               <th style="padding: 14px 12px; text-align: center;">Selisih</th>
               <th style="padding: 14px 12px; text-align: center;">Status</th>
             </tr>
           </thead>
           <tbody id="compare-body">${compareHtml}</tbody>
         </table>
      </div>
    </div>
    
    <a href="https://api-sekolah-kita.pages.dev/" class="btn" target="_blank" rel="noopener noreferrer">
      Kunjungi Website Utama
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/></svg>
    </a>
    
    <div style="font-size: 12px; color: var(--text-muted); margin-top: 24px; font-weight: 500;">
      Halaman refresh otomatis setiap 5 detik
    </div>
  </div>

  <script>
    async function showDuplicateModal(provinsi) {
      window.isAutoReloadPaused = true;
      const modal = document.getElementById('duplicate-modal');
      const title = document.getElementById('modal-title');
      const content = document.getElementById('modal-content');
      
      title.innerText = 'Detail NPSN Ganda - Provinsi ' + provinsi;
      content.innerHTML = '<div style="text-align: center; padding: 24px; color: var(--text-muted);"><span class="spin-icon">🔄</span> Memuat data NPSN...</div>';
      modal.style.display = 'block';
      
      try {
        const res = await fetch('/api/duplicates-detail?provinsi=' + encodeURIComponent(provinsi) + '&_t=' + Date.now());
        const json = await res.json();
        if (json.success && json.data && json.data.length > 0) {
          let html = '';
          json.data.forEach(function(item) {
            var isIdentical = true;
            if (item.sekolahList && item.sekolahList.length > 1) {
              var first = item.sekolahList[0];
              for (var i = 1; i < item.sekolahList.length; i++) {
                var current = item.sekolahList[i];
                if (current.nama !== first.nama ||
                    current.bentuk !== first.bentuk ||
                    current.status !== first.status ||
                    current.kecamatan !== first.kecamatan ||
                    current.kabupaten !== first.kabupaten ||
                    (current.alamat || '') !== (first.alamat || '')) {
                  isIdentical = false;
                  break;
                }
              }
            } else {
              isIdentical = false;
            }

            var borderColor = isIdentical ? 'var(--success)' : 'var(--danger)';
            var badgeHtml = isIdentical 
              ? '<span style="background: rgba(16, 185, 129, 0.15); color: #34d399; padding: 3px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; margin-left: 8px; border: 1px solid rgba(16, 185, 129, 0.3);">Data Identik (Paginasi API)</span>'
              : '<span style="background: rgba(244, 63, 94, 0.15); color: #fb7185; padding: 3px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; margin-left: 8px; border: 1px solid rgba(244, 63, 94, 0.3);">Data Berbeda (NPSN Ganda)</span>';

            html += '<div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 16px; margin-bottom: 12px; border-left: 4px solid ' + borderColor + ';">' +
                    '<div style="font-weight: 700; color: var(--primary-light); font-size: 14px; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">NPSN: ' + item.npsn + badgeHtml + '</div>' +
                    '<div style="display: flex; flex-direction: column; gap: 10px;">';
            item.sekolahList.forEach(function(s) {
              html += '<div style="padding-left: 10px; border-left: 2px solid rgba(255,255,255,0.1); font-size: 13px;">' +
                      '<strong style="color: var(--text-main);">' + s.nama + '</strong> <span style="background: rgba(255,255,255,0.08); color: var(--text-subtle); padding: 2px 6px; border-radius: 4px; font-size: 11px; text-transform: uppercase;">' + s.bentuk + '</span>' +
                      '<div style="color: var(--text-muted); margin-top: 4px;">Status: ' + s.status + ' | Kecamatan: ' + s.kecamatan + ' | Kabupaten: ' + s.kabupaten + '</div>' +
                      '<div style="color: var(--text-muted); font-size: 12px; margin-top: 2px;">Alamat: ' + (s.alamat || '-') + '</div>' +
                      '</div>';
            });
            html += '</div></div>';
          });
          content.innerHTML = html;
        } else {
          content.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--text-muted);">Tidak ada detail data NPSN ganda yang disimpan untuk provinsi ini. Jalankan sync ulang untuk memperbarui detail.</div>';
        }
      } catch (e) {
        content.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--danger);">Gagal memuat detail data: ' + e.message + '</div>';
      }
    }
    
    function closeDuplicateModal() {
      document.getElementById('duplicate-modal').style.display = 'none';
      window.isAutoReloadPaused = false;
    }
    
    window.addEventListener('click', function(event) {
      const modal = document.getElementById('duplicate-modal');
      if (event.target === modal) {
        closeDuplicateModal();
      }
    });
  </script>
  
  <!-- Modal Detail NPSN Ganda -->
  <div id="duplicate-modal" style="display: none; position: fixed; z-index: 1000; left: 0; top: 0; width: 100%; height: 100%; overflow: auto; background-color: rgba(0,0,0,0.7); backdrop-filter: blur(8px);">
    <div style="background: rgba(15, 23, 42, 0.95); margin: 8% auto; padding: 26px; border: 1px solid rgba(255,255,255,0.15); width: 90%; max-width: 620px; border-radius: 24px; box-shadow: 0 20px 50px rgba(0,0,0,0.8); text-align: left; position: relative;">
      <span style="position: absolute; right: 20px; top: 20px; font-size: 22px; font-weight: bold; cursor: pointer; color: var(--text-muted); width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.05);" onclick="closeDuplicateModal()">&times;</span>
      <h3 style="margin-top: 0; font-size: 17px; font-weight: 700; color: var(--text-main); border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 12px; display: flex; align-items: center; gap: 8px;" id="modal-title">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fb7185" stroke-width="2.2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
        Detail NPSN Ganda
      </h3>
      <div id="modal-content" style="max-height: 440px; overflow-y: auto; margin-top: 16px;">
        <!-- Content will be populated by JS -->
      </div>
    </div>
  </div>
</body>
</html>`;
        
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    });
  } catch (err) {
    return new Response('Error loading sync dashboard: ' + err.message, { status: 500 });
  }
}
