/**
 * Core fungsi sinkronisasi data dari portal belajar.id ke Supabase
 */

export const VALID_BENTUK = [
  'tk', 'kb', 'sps', 'tpa', 'paudq', 'sd', 'smp', 'sma', 'smk', 'slb',
  'skb', 'pkbm', 'kursus', 'ra', 'mi', 'mts', 'ma',
  'smak', 'smptk', 'smtk', 'sdtk', 'spk-kb', 'spk-sd', 'spk-sma', 'spk-smp', 'spk-tk',
  'spm-ula', 'spm-ulya', 'spm-wustha', 'taman-seminari', 'pdf-ulya', 'pdf-wustha',
  'mak', 'mula-dhammasekha', 'nava-dhammasekha', 'uttama-dhammasekha', 'pondok-pesantren',
  'smag-k'
];

export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function buildRowFingerprint(item) {
  const payload = {
    nama: item.nama ?? '',
    bentuk_pendidikan: item.bentukPendidikan ?? '',
    bentuk_pendidikan_group: item.bentukPendidikanGroup ?? '',
    jenis_pendidikan: item.jenisPendidikan ?? '',
    status_satuan_pendidikan: item.statusSatuanPendidikan ?? '',
    jenjang_pendidikan: item.jenjangPendidikan ?? '',
    pembina: item.pembina ?? '',
    jalur_pendidikan: item.jalurPendidikan ?? '',
    nama_desa: item.namaDesa ?? '',
    nama_kecamatan: item.namaKecamatan ?? '',
    nama_kabupaten: item.namaKabupaten ?? '',
    nama_provinsi: item.namaProvinsi ?? '',
    alamat_jalan: item.alamatJalan ?? '',
  };
  return sha256Hex(JSON.stringify(payload));
}

/**
 * Memproses batch data dari belajar.id langsung ke Supabase
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {Array<Record<string, any>>} dataList
 */
export async function syncBatchToSupabase(supabase, dataList = []) {
  const prepared = [];
  let tanpaNpsn = 0;

  for (const item of dataList) {
    if (!item.npsn) {
      tanpaNpsn++;
      continue;
    }
    prepared.push({
      item,
      npsn: String(item.npsn),
      rowFp: await buildRowFingerprint(item),
    });
  }

  if (prepared.length === 0) {
    return { baru: 0, diperbarui: 0, tidakBerubah: 0, tanpaNpsn };
  }

  // Cek fingerprint baris yang sudah ada di Supabase
  const npsnList = prepared.map((p) => p.npsn);
  const { data: existingRows, error: fetchErr } = await supabase
    .from('sekolah')
    .select('npsn, row_fp')
    .in('npsn', npsnList);

  if (fetchErr) {
    console.error('Gagal cek fingerprint yang ada di Supabase:', fetchErr.message);
    throw new Error('Gagal cek fingerprint yang ada di Supabase: ' + fetchErr.message);
  }

  const existingMap = new Map((existingRows || []).map((r) => [r.npsn, r.row_fp]));

  const toUpsertMap = new Map();
  let baru = 0;
  let diperbarui = 0;
  let tidakBerubah = 0;

  for (const entry of prepared) {
    const prevFp = existingMap.get(entry.npsn);
    if (prevFp === entry.rowFp) {
      tidakBerubah++;
      continue;
    }

    if (prevFp === undefined) {
      baru++;
    } else {
      diperbarui++;
    }

    const { item, rowFp } = entry;
    // Gunakan Map ber-key npsn agar batch selalu deduplikasi unik sebelum dikirim ke PostgreSQL
    toUpsertMap.set(entry.npsn, {
      npsn: entry.npsn,
      nama: item.nama || '',
      bentuk_pendidikan: item.bentukPendidikan ? String(item.bentukPendidikan).toUpperCase() : null,
      bentuk_pendidikan_group: item.bentukPendidikanGroup || null,
      jenis_pendidikan: item.jenisPendidikan || null,
      status_satuan_pendidikan: item.statusSatuanPendidikan || null,
      jenjang_pendidikan: item.jenjangPendidikan || null,
      pembina: item.pembina || null,
      jalur_pendidikan: item.jalurPendidikan || null,
      nama_desa: item.namaDesa || null,
      nama_kecamatan: item.namaKecamatan || null,
      nama_kabupaten: item.namaKabupaten || null,
      nama_provinsi: item.namaProvinsi || null,
      alamat_jalan: item.alamatJalan || null,
      row_fp: rowFp,
      migrated_at: new Date().toISOString(),
    });
  }

  const toUpsert = Array.from(toUpsertMap.values());

  if (toUpsert.length > 0) {
    const { error: upsertErr } = await supabase
      .from('sekolah')
      .upsert(toUpsert, { onConflict: 'npsn' });

    if (upsertErr) {
      throw new Error('Supabase batch upsert failed: ' + upsertErr.message);
    }
  }

  return { baru, diperbarui, tidakBerubah, tanpaNpsn };
}
