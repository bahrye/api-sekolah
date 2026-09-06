import { getSupabase } from './lib/db.js';

export async function onRequestGet(context) {
  try {
    const supabase = getSupabase(context.env);
    const { data } = await supabase
      .from('status_sinkronisasi')
      .select('bentuk_aktif, offset_terakhir')
      .eq('id', 1)
      .single();

    return new Response(
      JSON.stringify(data || { bentuk_aktif: 'tk', offset_terakhir: 0 }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ bentuk_aktif: 'tk', offset_terakhir: 0 }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }
}
