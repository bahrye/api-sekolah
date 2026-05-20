const jsonHeaders = {
  'Content-Type': 'application/json;charset=UTF-8',
  'Access-Control-Allow-Origin': '*',
};

/** Tidak tersedia untuk publik */
export async function onRequest() {
  return new Response(
    JSON.stringify({ status: 'error', message: 'Not found' }),
    { status: 404, headers: jsonHeaders }
  );
}
