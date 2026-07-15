import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// One-off manual refresh: exchanges the stored QuickBooks refresh_token for a new
// access_token + refresh_token pair (Intuit rotates the refresh token on every use)
// and writes both back to qb_tokens. Mirrors qb-auth-callback's token exchange.
Deno.serve(async (req: Request) => {
  const clientId = Deno.env.get('QB_CLIENT_ID')!;
  const clientSecret = Deno.env.get('QB_CLIENT_SECRET')!;
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;

  const supabase = createClient(
    supabaseUrl,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const { data: rows, error: fetchError } = await supabase
    .from('qb_tokens')
    .select('id, refresh_token')
    .limit(1);

  if (fetchError || !rows || rows.length === 0) {
    return new Response(JSON.stringify({ error: 'no_stored_token', detail: fetchError?.message }), { status: 500 });
  }

  const tokenRow = rows[0];
  const basicAuth = btoa(`${clientId}:${clientSecret}`);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokenRow.refresh_token,
  });

  const tokenResponse = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body,
  });

  const respText = await tokenResponse.text();

  if (!tokenResponse.ok) {
    return new Response(JSON.stringify({ error: 'refresh_failed', status: tokenResponse.status, detail: respText }), { status: 500 });
  }

  const tokens = JSON.parse(respText);
  const now = new Date();
  const accessExpires = new Date(now.getTime() + tokens.expires_in * 1000);
  const refreshExpires = new Date(now.getTime() + tokens.x_refresh_token_expires_in * 1000);

  const { error: updateError } = await supabase
    .from('qb_tokens')
    .update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      access_token_expires_at: accessExpires.toISOString(),
      refresh_token_expires_at: refreshExpires.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq('id', tokenRow.id);

  if (updateError) {
    return new Response(JSON.stringify({ error: 'store_failed', detail: updateError.message }), { status: 500 });
  }

  return new Response(JSON.stringify({
    ok: true,
    access_token_expires_at: accessExpires.toISOString(),
    refresh_token_expires_at: refreshExpires.toISOString(),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
