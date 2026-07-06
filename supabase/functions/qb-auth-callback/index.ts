import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const realmId = url.searchParams.get('realmId');
  const error = url.searchParams.get('error');

  if (error) {
    return new Response(`QuickBooks authorization failed: ${error}`, { status: 400 });
  }

  if (!code || !realmId) {
    return new Response('Missing code or realmId from QuickBooks', { status: 400 });
  }

  const clientId = Deno.env.get('QB_CLIENT_ID')!;
  const clientSecret = Deno.env.get('QB_CLIENT_SECRET')!;
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const redirectUri = `${supabaseUrl}/functions/v1/qb-auth-callback`;

  // Debug logging (safe - only partial values)
  console.log('DEBUG: clientId length:', clientId?.length, 'first 6:', clientId?.substring(0, 6));
  console.log('DEBUG: clientSecret length:', clientSecret?.length, 'first 4:', clientSecret?.substring(0, 4));
  console.log('DEBUG: redirectUri:', redirectUri);
  console.log('DEBUG: SUPABASE_URL:', supabaseUrl);
  console.log('DEBUG: code length:', code?.length);
  console.log('DEBUG: realmId:', realmId);

  // Exchange authorization code for tokens
  const basicAuth = btoa(`${clientId}:${clientSecret}`);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: redirectUri
  });

  console.log('DEBUG: token request body:', body.toString());

  const tokenResponse = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: body
  });

  const respText = await tokenResponse.text();
  console.log('DEBUG: token response status:', tokenResponse.status);
  console.log('DEBUG: token response body:', respText);

  if (!tokenResponse.ok) {
    return new Response(`Token exchange failed (${tokenResponse.status}): ${respText}`, { status: 500 });
  }

  const tokens = JSON.parse(respText);

  // Store tokens in Supabase
  const supabase = createClient(
    supabaseUrl,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );

  const now = new Date();
  const accessExpires = new Date(now.getTime() + tokens.expires_in * 1000);
  const refreshExpires = new Date(now.getTime() + tokens.x_refresh_token_expires_in * 1000);

  // Delete old tokens and insert new
  await supabase.from('qb_tokens').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  const { error: insertError } = await supabase.from('qb_tokens').insert({
    realm_id: realmId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    access_token_expires_at: accessExpires.toISOString(),
    refresh_token_expires_at: refreshExpires.toISOString(),
    updated_at: now.toISOString()
  });

  if (insertError) {
    console.error('Failed to store tokens:', insertError);
    return new Response(`Failed to store tokens: ${insertError.message}`, { status: 500 });
  }

  return new Response(null, {
    status: 302,
    headers: {
      'Location': 'https://crle.lovable.app?qb_connected=true'
    }
  });
});
