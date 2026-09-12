import rekapPrecomputed from '../../data_rekap.json';

export async function onRequest(context) {
  const headers = {
    'Content-Type': 'application/json;charset=UTF-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
  };

  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  try {
    return new Response(JSON.stringify(rekapPrecomputed), { headers });
  } catch (error) {
    return new Response(
      JSON.stringify({
        status: 'error',
        message: 'Gagal memproses rekap data: ' + error.message,
      }),
      { headers, status: 500 }
    );
  }
}
