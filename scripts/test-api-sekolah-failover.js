import { onRequest } from '../functions/api/sekolah.js';

async function testApiFailover() {
  console.log('🧪 Memulai pengujian Integrasi functions/api/sekolah.js Failover...');

  // Mock context dengan SUPABASE_URL yang salah untuk mensimulasikan server Supabase mati/down
  const mockContextWithDeadSupabase = {
    request: new Request('http://localhost:8788/api/sekolah?provinsi=LUAR%20NEGERI&limit=3'),
    env: {
      SUPABASE_URL: 'https://invalid-supabase-down.example.com',
      SUPABASE_ANON_KEY: 'invalid_key',
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

  const response = await onRequest(mockContextWithDeadSupabase);
  const data = await response.json();

  console.log('HTTP Status Code:', response.status);
  console.log('Status Payload:', data.status);
  console.log('Source:', data.source);
  console.log('Fallback Mode:', data.metadata?.fallback_mode);
  console.log('Catatan Fallback:', data.metadata?.fallback_info);
  console.log('Data Length:', data.data?.length);

  if (response.status === 200 && data.metadata?.fallback_mode === true && data.data?.length > 0) {
    console.log('\n🎉 UJI FAILOVER API BERHASIL 100%! API berhasil mengalihkan ke static backup saat Supabase mati.');
  } else {
    console.error('❌ Uji failover gagal. Response tidak sesuai harapan:', data);
    process.exit(1);
  }
}

testApiFailover().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
