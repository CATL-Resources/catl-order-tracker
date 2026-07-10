import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Parent folder IDs by manufacturer ID and year
const PARENT_FOLDERS: Record<string, string> = {
  // Moly 2026
  'b5cf513b-c38b-443e-bd13-8b2e79e1ccb6': '1XbMvfvbnR0PgOUeXqY0JCuHwqBwgOxrX',
  // Daniels 2026
  '15e8fe09-0653-4282-ad34-1c9c24eb0f59': '1vXPiyREiR1Bwvuy8SJKRndJUSVyHY592',
  // Rawhide (all years)
  '6bd9b7c0-c4e7-4d8b-be06-e1f2271fe12a': '1V8WzsJapJuwzg3GEmIhqqn2gt9uHN7c7',
  // MJE (all years)
  'b5163075-9b86-42b9-a7bb-aae43159e420': '1oX4G4SMtRgYivBIVDv_AlvNyQEJ9MsXZ',
};

// Also maintain a mapping of all known folder IDs for scanning existing folders
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

  const expiresAt = new Date(tokenRow.access_token_expires_at);
  if (expiresAt.getTime() - Date.now() > 5 * 60 * 1000) {
    return tokenRow.access_token;
  }

  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;

  const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokenRow.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!refreshRes.ok) return null;
  const refreshData = await refreshRes.json();

  await supabase
    .from('google_tokens')
    .update({
      access_token: refreshData.access_token,
      access_token_expires_at: new Date(Date.now() + refreshData.expires_in * 1000).toISOString(),
    })
    .eq('account_email', 'timselect@gmail.com');

  return refreshData.access_token;
}

async function listSubfolders(accessToken: string, parentFolderId: string): Promise<Map<string, any>> {
  const folders = new Map();
  let pageToken = '';

  do {
    const query = `'${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name,webViewLink)&pageSize=100`;
    if (pageToken) url += `&pageToken=${pageToken}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) break;
    const data = await res.json();
    for (const f of data.files || []) {
      // Extract contract number from folder name
      const match = f.name.match(/(?:Contract\s+)?(\d{4,5})/i);
      if (match) folders.set(match[1], f);
      // Also store by full name for Daniels-style matching
      folders.set(f.name, f);
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return folders;
}

async function createDriveFolder(
  accessToken: string,
  folderName: string,
  parentFolderId: string
): Promise<{ id: string; webViewLink: string } | null> {
  const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId],
    }),
  });

  if (!res.ok) return null;
  return await res.json();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const dryRun = body.dry_run !== false;

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
      return new Response(JSON.stringify({ success: true, message: 'All orders already linked', linked: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // First, scan all parent folders for existing subfolders
    const existingFolders = new Map<string, any>();
    for (const pf of ALL_PARENT_FOLDERS) {
      const subs = await listSubfolders(accessToken, pf.id);
      for (const [key, val] of subs) {
        existingFolders.set(key, { ...val, parentLabel: pf.label });
      }
    }

    const results: any[] = [];
    let linked = 0;
    let created = 0;
    let errors = 0;

    for (const order of orders) {
      const contractNum = order.moly_contract_number || order.qb_po_doc_number;
      if (!contractNum) {
        results.push({ order: order.contract_name, action: 'skipped', reason: 'no contract number' });
        continue;
      }

      const parentFolderId = order.manufacturer_id ? PARENT_FOLDERS[order.manufacturer_id] : null;
      if (!parentFolderId) {
        results.push({ order: order.contract_name, action: 'skipped', reason: 'no parent folder mapped for manufacturer' });
        continue;
      }

      // Check if folder already exists
      const existing = existingFolders.get(contractNum);
      if (existing) {
        const driveUrl = existing.webViewLink || `https://drive.google.com/drive/folders/${existing.id}`;

        if (dryRun) {
          results.push({
            order: order.contract_name,
            action: 'would_link_existing',
            folder_name: existing.name,
            folder_id: existing.id,
          });
        } else {
          await supabase.from('orders').update({
            google_drive_folder_id: existing.id,
            google_drive_folder_url: driveUrl,
          }).eq('id', order.id);

          linked++;
          results.push({
            order: order.contract_name,
            action: 'linked_existing',
            folder_name: existing.name,
          });
        }
        continue;
      }

      // Folder doesn't exist — create it
      // Naming convention: "Contract {number} – {contract_name}" for Moly,
      // or just the PO doc number for Daniels/Rawhide
      let folderName: string;
      if (order.moly_contract_number) {
        // Strip the contract number from contract_name since it'll be in the prefix
        const cleanName = (order.contract_name || '')
          .replace(/#\d+$/, '')
          .replace(/\s+$/, '')
          .trim();
        folderName = `Contract ${order.moly_contract_number} – ${cleanName || 'CATL'}`;
      } else {
        folderName = order.contract_name || `PO ${contractNum}`;
      }

      if (dryRun) {
        results.push({
          order: order.contract_name,
          action: 'would_create',
          folder_name: folderName,
          parent_folder: parentFolderId,
        });
      } else {
        const newFolder = await createDriveFolder(accessToken, folderName, parentFolderId);
        if (newFolder) {
          const driveUrl = newFolder.webViewLink || `https://drive.google.com/drive/folders/${newFolder.id}`;

          await supabase.from('orders').update({
            google_drive_folder_id: newFolder.id,
            google_drive_folder_url: driveUrl,
          }).eq('id', order.id);

          created++;
          results.push({
            order: order.contract_name,
            action: 'created',
            folder_name: folderName,
            folder_id: newFolder.id,
          });
        } else {
          errors++;
          results.push({
            order: order.contract_name,
            action: 'error',
            reason: 'Drive API create failed',
          });
        }
      }
    }

    return new Response(JSON.stringify({
      success: true,
      dry_run: dryRun,
      total_orders: orders.length,
      linked_existing: linked,
      created_new: created,
      errors,
      results,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
