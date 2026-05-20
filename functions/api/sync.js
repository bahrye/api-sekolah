const jsonHeaders = {
  'Content-Type': 'application/json;charset=UTF-8',
  'Access-Control-Allow-Origin': '*',
};

/** Sinkron lewat Worker / GitHub Actions — endpoint Pages tidak tersedia untuk publik */
export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers: jsonHeaders });
  }

  return new Response(
    JSON.stringify({
      status: 'error',
      message:
        'Sinkronisasi tidak tersedia di API publik. Data diperbarui melalui proses sinkron terpisah.',
    }),
    { status: 404, headers: jsonHeaders }
  );
}
