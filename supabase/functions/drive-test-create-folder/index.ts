import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Get Google access token
    const { data: tokenRow } = await supabase
      .from('google_tokens')
      .select('access_token')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    if (!tokenRow) {
      return new Response(JSON.stringify({ success: false, error: 'No Google token' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Try to create a test folder inside SILENCER 2026
    const parentFolderId = '1XbMvfvbnR0PgOUeXqY0JCuHwqBwgOxrX';
    const testFolderName = 'TEST - Delete Me';

    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenRow.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: testFolderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentFolderId],
      }),
    });

    const responseText = await createRes.text();

    return new Response(JSON.stringify({
      success: createRes.ok,
      status: createRes.status,
      response: responseText,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
