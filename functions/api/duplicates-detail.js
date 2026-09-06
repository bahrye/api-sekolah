import { getSupabase } from '../lib/db.js';

export async function onRequestGet(context) {
  try {
    const supabase = getSupabase(context.env);
    const url = new URL(context.request.url);
    const provinsi = url.searchParams.get('provinsi');

    if (!provinsi) {
      return new Response(
        JSON.stringify({ success: false, error: 'Provinsi parameter is required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const { data: rows, error } = await supabase
      .from('npsn_ganda_detail')
      .select('npsn, sekolah_detail')
      .eq('nama_provinsi', provinsi);

    if (error) throw error;

    const data = (rows || []).map((r) => {
      let parsed = [];
      try {
        parsed = typeof r.sekolah_detail === 'string' ? JSON.parse(r.sekolah_detail) : r.sekolah_detail;
      } catch (e) {}
      return {
        npsn: r.npsn,
        sekolahList: parsed,
      };
    });

    return new Response(JSON.stringify({ success: true, data }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
