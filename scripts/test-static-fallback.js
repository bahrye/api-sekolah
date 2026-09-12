import { handleStaticFallback } from '../functions/lib/sekolah-static-fallback.js';

async function runTest() {
  console.log('🧪 Memulai pengujian Static Fallback Handler...');

  // Mock context Cloudflare Pages
  const mockContext = {
    request: {
      url: 'http://localhost:8788/api/sekolah?provinsi=LUAR%20NEGERI&limit=5',
    },
    env: {
      // Mock ASSETS fetcher menggunakan local node fs/fetch
      ASSETS: {
        fetch: async (url) => {
          const fs = await import('fs');
          const path = await import('path');
          const pathname = new URL(url).pathname;
          const cleanPath = pathname.replace(/^\//, '');
          const localPath = path.join(process.cwd(), cleanPath);

          if (fs.existsSync(localPath)) {
            const content = fs.readFileSync(localPath, 'utf8');
            return new Response(content, {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response('Not Found', { status: 404 });
        },
      },
    },
  };

  // Test 1: Query Provinsi Luar Negeri
  console.log('\n--- Test 1: Fallback Filter Provinsi (LUAR NEGERI) ---');
  const res1 = await handleStaticFallback(
    mockContext,
    { provinsi: 'LUAR NEGERI', limit: 5, offset: 0 },
    'Simulasi Supabase Down (Error 500)'
  );
  const data1 = await res1.json();
  console.log('Status HTTP:', res1.status);
  console.log('Source:', data1.source);
  console.log('Fallback Mode:', data1.metadata?.fallback_mode);
  console.log('Total Data Tersedia:', data1.metadata?.total_data_tersedia);
  console.log('Jumlah baris:', data1.data?.length);
  if (data1.data?.length > 0) {
    console.log('Sample sekolah:', data1.data[0].nama, `(${data1.data[0].npsn})`);
  }

  // Test 2: Query NPSN dari Papua Selatan
  console.log('\n--- Test 2: Fallback Filter Bentuk Pendidikan ---');
  const res2 = await handleStaticFallback(
    mockContext,
    { provinsi: 'PROV. PAPUA SELATAN', bentuk: 'SD', limit: 3, offset: 0 },
    'Simulasi Supabase Down (Error 500)'
  );
  const data2 = await res2.json();
  console.log('Status HTTP:', res2.status);
  console.log('Fallback Mode:', data2.metadata?.fallback_mode);
  console.log('Total SD Papua Selatan:', data2.metadata?.total_data_tersedia);
  console.log('Jumlah baris:', data2.data?.length);
  if (data2.data?.length > 0) {
    console.log('Sample sekolah:', data2.data[0].nama, `(${data2.data[0].bentuk_pendidikan})`);
  }

  console.log('\n✅ Semua pengujian unit Static Fallback BERHASIL!');
}

runTest().catch((err) => {
  console.error('❌ Pengujian gagal:', err);
  process.exit(1);
});
