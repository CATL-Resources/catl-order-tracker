import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ALL_PARENT_FOLDERS = [
  { id: '1XbMvfvbnR0PgOUeXqY0JCuHwqBwgOxrX', label: 'SILENCER 2026' },
  { id: '1GW2IZELTNmBNup9qdoKZqdBnDc6Z-Mn6', label: 'SILENCER 2025' },
  { id: '1vXPiyREiR1Bwvuy8SJKRndJUSVyHY592', label: 'Daniels 2026' },
  { id: '1MevH9MCkq15jxRcIsKlztb6bUCI_H8si', label: 'DANIELS 2025' },
  { id: '1V8WzsJapJuwzg3GEmIhqqn2gt9uHN7c7', label: 'RAWHIDE' },
  { id: '1oX4G4SMtRgYivBIVDv_AlvNyQEJ9MsXZ', label: 'MJE' },
];

async function refreshGoogleToken(supabase: any): Promise<string | null> {
  const { data: tokenRow } = await supabase
    .from('google_tokens')
    .select('access_token, refresh_token, access_token_expires_at')
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();
  if (!tokenRow) return null;
  if (new Date(tokenRow.access_token_expires_at).getTime() - Date.now() > 5 * 60 * 1000) {
    return tokenRow.access_token;
  }
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;
  const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: tokenRow.refresh_token, grant_type: 'refresh_token',
    }),
  });
  if (!refreshRes.ok) return null;
  const refreshData = await refreshRes.json();
  await supabase.from('google_tokens').update({
    access_token: refreshData.access_token,
    access_token_expires_at: new Date(Date.now() + refreshData.expires_in * 1000).toISOString(),
  }).eq('account_email', 'timselect@gmail.com');
  return refreshData.access_token;
}

async function listSubfolders(accessToken: string, parentFolderId: string): Promise<any[]> {
  const allFolders: any[] = [];
  let pageToken = '';
  do {
    const query = `'${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name,webViewLink)&pageSize=100`;
    if (pageToken) url += `&pageToken=${pageToken}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) break;
    const data = await res.json();
    allFolders.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return allFolders;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const accessToken = await refreshGoogleToken(supabase);
    if (!accessToken) {
      return new Response(JSON.stringify({ success: false, error: 'No Google token' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get orders without Drive folders
    const { data: orders } = await supabase
      .from('orders')
      .select('id, moly_contract_number, qb_po_doc_number, contract_name, manufacturer_id')
      .is('google_drive_folder_id', null);

    if (!orders || orders.length === 0) {
      return new Response(JSON.stringify({ success: true, message: 'All orders already linked' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Scan all parent folders
    const foldersByContractNum = new Map<string, any>();
    for (const pf of ALL_PARENT_FOLDERS) {
      const subs = await listSubfolders(accessToken, pf.id);
      for (const f of subs) {
        const match = f.name.match(/(?:Contract\s+)?(\d{4,5})/i);
        if (match) {
          foldersByContractNum.set(match[1], { ...f, parentLabel: pf.label });
        }
      }
    }

    const linkedResults: any[] = [];
    const noFolderResults: any[] = [];

    for (const order of orders) {
      const contractNum = order.moly_contract_number || order.qb_po_doc_number;
      if (!contractNum) {
        noFolderResults.push({ contract: 'none', order_name: order.contract_name, reason: 'no contract number' });
        continue;
      }

      const existing = foldersByContractNum.get(contractNum);
      if (existing) {
        const driveUrl = existing.webViewLink || `https://drive.google.com/drive/folders/${existing.id}`;

        await supabase.from('orders').update({
          google_drive_folder_id: existing.id,
          google_drive_folder_url: driveUrl,
        }).eq('id', order.id);

        linkedResults.push({
          contract: contractNum,
          order_name: order.contract_name,
          drive_folder_name: existing.name,
          drive_url: driveUrl,
        });
      } else {
        noFolderResults.push({
          contract: contractNum,
          order_name: order.contract_name,
        });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      linked_count: linkedResults.length,
      no_folder_count: noFolderResults.length,
      linked: linkedResults,
      no_folder: noFolderResults,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
