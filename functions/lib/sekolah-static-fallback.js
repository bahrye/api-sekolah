/**
 * Modul Fallback Statis untuk API Sekolah
 * Mengambil data sekolah dari file Static JSON di folder data_provinsi/
 * ketika database utama (Supabase) mengalami downtime/error.
 */

const DEVELOPER = 'Syamsul Bahri';

function getSlug(name) {
  return (name || '')
    .toLowerCase()
    .replace(/^provinsi\s+|^prov\.\s+|^prov\s+/i, '')
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Membaca file JSON statis dari Cloudflare Pages Assets
 * @param {any} context
 * @param {string} relativePath
 */
async function loadAssetJson(context, relativePath) {
  const cleanPath = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;

  // 1. Coba melalui context.env.ASSETS (Cloudflare Pages Functions)
  if (context.env?.ASSETS) {
    try {
      const url = new URL(cleanPath, context.request.url);
      const res = await context.env.ASSETS.fetch(url);
      if (res.ok) {
        return await res.json();
      }
    } catch (e) {
      console.warn(`[StaticFallback] Gagal baca via ASSETS ${cleanPath}:`, e.message);
    }
  }

  // 2. Coba fetch langsung via origin URL
  try {
    const originUrl = new URL(cleanPath, context.request.url);
    const res = await fetch(originUrl.toString());
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {}

  return null;
}

/**
 * Handler failover ketika Supabase tidak dapat diakses
 * @param {any} context
 * @param {{ keyword?: string, provinsi?: string, bentuk?: string, limit: number, offset: number }} params
 * @param {string} originalError
 */
export async function handleStaticFallback(context, params, originalError = '') {
  const { keyword, provinsi, bentuk, limit = 20, offset = 0 } = params;

  // 1. Muat metadata index
  const index = await loadAssetJson(context, '/data_provinsi/index.json');
  let matchedRows = [];
  let totalCandidates = 0;
  let targetFile = null;

  if (index) {
    const slugMap = index.slug_map || {};

    if (provinsi) {
      // 2a. Jika ada filter Provinsi
      const rawProv = provinsi.trim();
      let countryFilter = null;
      let targetFiles = [];

      if (rawProv.toUpperCase() === 'LUAR NEGERI') {
        targetFiles = ['data_luar_negeri.json'];
      } else if (rawProv.toUpperCase().startsWith('LUAR NEGERI - ')) {
        targetFiles = ['data_luar_negeri.json'];
        countryFilter = rawProv.substring(14).trim().toUpperCase();
      } else {
        const provSlug = getSlug(rawProv);
        const mapped = slugMap[provSlug] || slugMap[rawProv.toLowerCase()] || [`data_${provSlug}.json`];
        targetFiles = Array.isArray(mapped) ? mapped : [mapped];
      }

      let list = [];
      for (const fn of targetFiles) {
        const provinceData = await loadAssetJson(context, `/data_provinsi/${fn}`);
        if (Array.isArray(provinceData)) {
          list.push(...provinceData);
        }
      }

      if (list.length > 0) {
        if (countryFilter) {
          list = list.filter(r => (r.nama_kabupaten || '').toUpperCase() === countryFilter);
        }

        if (bentuk) {
          const upperBentuk = bentuk.trim().toUpperCase();
          list = list.filter(r => (r.bentuk_pendidikan || '').toUpperCase() === upperBentuk);
        }

        if (keyword) {
          const kw = keyword.trim().toUpperCase();
          list = list.filter(r =>
            (r.npsn || '').toUpperCase().includes(kw) ||
            (r.nama || '').toUpperCase().includes(kw)
          );
        }

        totalCandidates = list.length;
        matchedRows = list.slice(offset, offset + limit);
      }
    } else if (keyword) {
      // 2b. Pencarian berdasarkan kata kunci tanpa filter provinsi
      const cleanKw = keyword.trim().toUpperCase();

      // Cek apakah berupa NPSN (atau diawali angka 3 digit)
      const prefix = cleanKw.substring(0, 3);
      const targetSlugs = index.npsn_prefix_map?.[prefix] || (index.provinsi || []).flatMap(p => p.files || [p.file]);
      const isExactNpsn = /^\d{8}$/.test(cleanKw) || /^[Pp]\d{7}$/.test(cleanKw);

      if (targetSlugs.length > 0) {
        if (isExactNpsn) {
          // Exact match NPSN: cari sampai ketemu lalu berhenti
          for (const item of targetSlugs) {
            const fn = item.endsWith('.json') ? item : `data_${item}.json`;
            const pData = await loadAssetJson(context, `/data_provinsi/${fn}`);
            if (Array.isArray(pData)) {
              const exact = pData.find(r => (r.npsn || '').toUpperCase() === cleanKw);
              if (exact) {
                matchedRows.push(exact);
                break;
              }
            }
          }
        } else {
          // Partial search: ambil hingga batas limit
          for (const item of targetSlugs) {
            const fn = item.endsWith('.json') ? item : `data_${item}.json`;
            const pData = await loadAssetJson(context, `/data_provinsi/${fn}`);
            if (Array.isArray(pData)) {
              const found = pData.filter(r =>
                (r.npsn || '').toUpperCase().includes(cleanKw) ||
                (r.nama || '').toUpperCase().includes(cleanKw)
              );
              matchedRows.push(...found);
              if (matchedRows.length >= offset + limit) break;
            }
          }
        }
        totalCandidates = matchedRows.length;
        matchedRows = matchedRows.slice(offset, offset + limit);
      } else {
        // Fallback ke sample data jika tidak ada mapping
        const sample = index.sample_schools || [];
        const found = sample.filter(r =>
          (r.npsn || '').toUpperCase().includes(cleanKw) ||
          (r.nama || '').toUpperCase().includes(cleanKw)
        );
        totalCandidates = found.length;
        matchedRows = found.slice(offset, offset + limit);
      }
    } else {
      // 2c. Request default tanpa parameter (misal: /api/sekolah?limit=20)
      const sample = index.sample_schools || [];
      totalCandidates = sample.length;
      matchedRows = sample.slice(offset, offset + limit);
    }
  }

  const headers = {
    'Content-Type': 'application/json;charset=UTF-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Cache-Control': 'public, max-age=600, s-maxage=3600',
    'X-Data-Source': 'Static-Fallback-CDN',
  };

  const metadata = {
    limit_ditampilkan: limit,
    offset_saat_ini: offset,
    total_data_tersedia: totalCandidates,
    has_more: offset + matchedRows.length < totalCandidates,
    waktu_update_data_terakhir: index?.last_updated || new Date().toISOString(),
    developer: DEVELOPER,
    fallback_mode: true,
    fallback_info: 'Database utama (Supabase) sedang dalam pemeliharaan. Data ini disajikan dari salinan cadangan statis di edge CDN.',
  };

  const responsePayload = {
    status: 'success',
    source: 'API Sekolah Mandiri (Static Fallback Cache)',
    developer: DEVELOPER,
    metadata,
    data: matchedRows,
  };

  if (keyword && matchedRows.length === 0) {
    responsePayload.message = 'Hmm, data tidak ditemukan di arsip cadangan statis. Pastikan NPSN atau nama sekolah sudah sesuai.';
  }

  return new Response(JSON.stringify(responsePayload), { headers, status: 200 });
}
