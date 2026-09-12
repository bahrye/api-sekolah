require('dotenv').config({ path: '.env.supabase' });
const { Client } = require('pg');
const { getDataSourceUrl } = require('./source-config.cjs');

const API_BASE = getDataSourceUrl();
const connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString) {
  console.error('SUPABASE_DB_URL belum diatur.');
  process.exit(1);
}
const pgClient = new Client({ connectionString });

const TARGETS = [
  {
    kode: '150000',
    nama: 'KALIMANTAN SELATAN',
    shapesToCheck: ['tk', 'kb']
  },
  {
    kode: '340000',
    nama: 'KALIMANTAN UTARA',
    shapesToCheck: ['tk', 'smk']
  },
  {
    kode: '290000',
    nama: 'KEPULAUAN BANGKA BELITUNG',
    shapesToCheck: ['kursus', 'sd', 'kb', 'smp', 'sps', 'pkbm']
  }
];

async function fetchAllApiNpsns(kodeWilayah, bentuk, totalApi) {
  const set = new Set();
  const limit = 20;
  const offsets = [];
  for (let o = 0; o < totalApi; o += limit) offsets.push(o);
  let curr = 0;
  async function worker() {
    while (curr < offsets.length) {
      const offset = offsets[curr++];
      try {
        const res = await fetch(`${API_BASE}/${kodeWilayah}?limit=${limit}&offset=${offset}&bentukPendidikan=${bentuk}`);
        if (res.ok) {
          const j = await res.json();
          (j.data || []).forEach(d => { if (d.npsn) set.add(String(d.npsn)); });
        }
      } catch (e) {}
    }
  }
  await Promise.all(Array.from({ length: 8 }, () => worker()));
  return set;
}

async function run() {
  await pgClient.connect();
  console.log('🚀 Memulai identifikasi dan pembersihan sekolah non-aktif untuk Kalsel, Kaltara, dan Babel...\n');

  const allStaleNpsns = [];

  for (const t of TARGETS) {
    console.log(`=== ${t.nama} (${t.kode}) ===`);
    const staleInProv = [];

    for (const shape of t.shapesToCheck) {
      // 1. Ambil meta total di API
      const apiRes = await fetch(`${API_BASE}/${t.kode}?limit=1&offset=0&bentukPendidikan=${shape}`);
      const apiJson = await apiRes.json();
      const apiTotal = apiJson.meta?.total || 0;

      // 2. Ambil data sekolah dari DB untuk bentuk ini
      const shapeSql = shape.replace(/-/g, ' ');
      const dbRes = await pgClient.query(
        `SELECT npsn, nama, bentuk_pendidikan FROM sekolah WHERE nama_provinsi ILIKE $1 AND (lower(bentuk_pendidikan) = $2 OR lower(replace(bentuk_pendidikan, '-', ' ')) = $3)`,
        [`%${t.nama}%`, shape.toLowerCase(), shapeSql.toLowerCase()]
      );
      const dbRows = dbRes.rows;

      console.log(`  Bentuk [${shape.toUpperCase()}]: DB = ${dbRows.length}, API = ${apiTotal}`);

      if (dbRows.length > apiTotal) {
        // Ambil seluruh NPSN dari API
        const apiNpsns = await fetchAllApiNpsns(t.kode, shape, apiTotal);
        const stale = dbRows.filter(r => !apiNpsns.has(String(r.npsn)));
        console.log(`  -> Ditemukan ${stale.length} sekolah non-aktif di DB untuk [${shape.toUpperCase()}]:`);
        stale.forEach(s => console.log(`     - [${s.npsn}] ${s.nama} (${s.bentuk_pendidikan})`));
        staleInProv.push(...stale);
      }
    }

    console.log(`  Total sekolah non-aktif terdeteksi di ${t.nama}: ${staleInProv.length}\n`);
    allStaleNpsns.push(...staleInProv);
  }

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`TOTAL KESELURUHAN SEKOLAH NON-AKTIF AKAN DIHAPUS: ${allStaleNpsns.length}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  if (allStaleNpsns.length > 0) {
    const npsnList = allStaleNpsns.map(s => s.npsn);
    console.log('Menghapus dari tabel sekolah Supabase...');
    const delRes = await pgClient.query('DELETE FROM sekolah WHERE npsn = ANY($1::text[]) RETURNING npsn', [npsnList]);
    console.log(`✅ Berhasil menghapus ${delRes.rowCount} baris sekolah non-aktif.`);

    // Periksa kembali total aktual di DB untuk tiap provinsi
    for (const t of TARGETS) {
      const dbRes = await pgClient.query(`SELECT count(*) FROM sekolah WHERE nama_provinsi ILIKE $1`, [`%${t.nama}%`]);
      const gRes = await fetch(`${API_BASE}/${t.kode}?limit=1&offset=0`);
      const gJson = await gRes.json();
      const apiMeta = gJson.meta?.total || 0;
      const dbCount = parseInt(dbRes.rows[0].count);
      console.log(`📊 ${t.nama}: API = ${apiMeta}, DB = ${dbCount}, Selisih = ${apiMeta - dbCount}`);

      // Update provinsi_sync_status
      await pgClient.query(
        `UPDATE provinsi_sync_status SET total_db = $1, terakhir_sukses = NOW() WHERE nama_provinsi ILIKE $2`,
        [dbCount, `%${t.nama}%`]
      );
    }
  }

  await pgClient.end();
  console.log('\n🎉 Proses pembersihan selesai sempurna!');
}

run().catch(err => {
  console.error('Error saat pembersihan:', err);
  process.exit(1);
});
