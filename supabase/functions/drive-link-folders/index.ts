import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Known parent folder IDs for each manufacturer/year
const DRIVE_FOLDERS: Record<string, { manufacturer_id: string; folder_id: string; label: string }[]> = {
  // Moly/Silencer
  'b5cf513b-c38b-443e-bd13-8b2e79e1ccb6': [
    { manufacturer_id: 'b5cf513b-c38b-443e-bd13-8b2e79e1ccb6', folder_id: '1XbMvfvbnR0PgOUeXqY0JCuHwqBwgOxrX', label: 'SILENCER 2026' },
    { manufacturer_id: 'b5cf513b-c38b-443e-bd13-8b2e79e1ccb6', folder_id: '1GW2IZELTNmBNup9qdoKZqdBnDc6Z-Mn6', label: 'SILENCER 2025' },
  ],
  // Daniels
  '15e8fe09-0653-4282-ad34-1c9c24eb0f59': [
    { manufacturer_id: '15e8fe09-0653-4282-ad34-1c9c24eb0f59', folder_id: '1vXPiyREiR1Bwvuy8SJKRndJUSVyHY592', label: 'Daniels 2026' },
    { manufacturer_id: '15e8fe09-0653-4282-ad34-1c9c24eb0f59', folder_id: '1MevH9MCkq15jxRcIsKlztb6bUCI_H8si', label: 'DANIELS 2025' },
  ],
  // Rawhide
  '6bd9b7c0-c4e7-4d8b-be06-e1f2271fe12a': [
    { manufacturer_id: '6bd9b7c0-c4e7-4d8b-be06-e1f2271fe12a', folder_id: '1V8WzsJapJuwzg3GEmIhqqn2gt9uHN7c7', label: 'RAWHIDE' },
  ],
};

async function refreshGoogleToken(supabase: any): Promise<string | null> {
  const { data: tokenRow } = await supabase
    .from('google_tokens')
    .select('access_token, refresh_token, access_token_expires_at')
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();

  if (!tokenRow) return null;

  const expiresAt = new Date(tokenRow.access_token_expires_at);
  const now = new Date();

  // If token still valid (with 5 min buffer), use it
  if (expiresAt.getTime() - now.getTime() > 5 * 60 * 1000) {
    return tokenRow.access_token;
  }

  // Refresh the token
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
  const newExpiry = new Date(Date.now() + refreshData.expires_in * 1000);

  await supabase
    .from('google_tokens')
    .update({
      access_token: refreshData.access_token,
      access_token_expires_at: newExpiry.toISOString(),
    })
    .eq('account_email', 'timselect@gmail.com');

  return refreshData.access_token;
}

async function listSubfolders(accessToken: string, parentFolderId: string): Promise<any[]> {
  const allFolders: any[] = [];
  let pageToken = '';

  do {
    const query = `'${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name,webViewLink)&pageSize=100`;
    if (pageToken) url += `&pageToken=${pageToken}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Drive API ${res.status}: ${errText}`);
    }

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
    const body = await req.json().catch(() => ({}));
    const dryRun = body.dry_run !== false;

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Get Google access token
    const accessToken = await refreshGoogleToken(supabase);
    if (!accessToken) {
      return new Response(JSON.stringify({ success: false, error: 'Could not get Google access token' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get all orders that don't have a Drive folder linked yet
    const { data: orders } = await supabase
      .from('orders')
      .select('id, moly_contract_number, qb_po_doc_number, contract_name, manufacturer_id, google_drive_folder_id')
      .is('google_drive_folder_id', null);

    if (!orders || orders.length === 0) {
      return new Response(JSON.stringify({ success: true, message: 'All orders already have Drive folders linked', matched: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Build a lookup: contract number/PO number -> order
    const ordersByIdentifier = new Map<string, any>();
    for (const order of orders) {
      if (order.moly_contract_number) {
        ordersByIdentifier.set(order.moly_contract_number, order);
      }
      if (order.qb_po_doc_number) {
        ordersByIdentifier.set(order.qb_po_doc_number, order);
      }
      // Also try the contract name for Daniels-style matching
      if (order.contract_name) {
        ordersByIdentifier.set(order.contract_name, order);
      }
    }

    // Scan all manufacturer Drive folders
    const results: any[] = [];
    const errors: any[] = [];
    let matched = 0;
    let unmatched = 0;

    for (const [mfgId, folders] of Object.entries(DRIVE_FOLDERS)) {
      for (const folder of folders) {
        let subfolders: any[];
        try {
          subfolders = await listSubfolders(accessToken, folder.folder_id);
        } catch (err) {
          errors.push({ folder: folder.label, error: String(err) });
          continue;
        }

        for (const sf of subfolders) {
          const folderName = sf.name || '';

          // Try to extract a contract number from the folder name
          // Patterns: "Contract 44520 – Ranch WB", "44520", "44520 - Something",
          // "2026 - McCrory", "McCrory", etc.
          let matchedOrder = null;

          // Try exact match on contract number extracted from folder name
          // Pattern 1: "Contract XXXXX" or just "XXXXX" at start
          const contractMatch = folderName.match(/(?:Contract\s+)?(\d{4,5})/i);
          if (contractMatch) {
            matchedOrder = ordersByIdentifier.get(contractMatch[1]);
          }

          // Pattern 2: Try full folder name contains any of our PO doc numbers
          if (!matchedOrder) {
            for (const [identifier, order] of ordersByIdentifier.entries()) {
              // Check if the folder name contains the identifier
              if (folderName.includes(identifier)) {
                matchedOrder = order;
                break;
              }
              // Check if the identifier contains a customer name that's in the folder
              // e.g., order "Daniels Mfg - 2026 - McCrory" and folder "McCrory"
              const nameParts = identifier.split(/[-–—]/).map((p: string) => p.trim()).filter((p: string) => p.length > 3);
              for (const part of nameParts) {
                if (folderName.toLowerCase().includes(part.toLowerCase()) && part.length > 4) {
                  matchedOrder = order;
                  break;
                }
              }
              if (matchedOrder) break;
            }
          }

          if (matchedOrder && !matchedOrder.google_drive_folder_id) {
            const driveUrl = sf.webViewLink || `https://drive.google.com/drive/folders/${sf.id}`;

            if (dryRun) {
              results.push({
                action: 'would_link',
                folder_name: folderName,
                folder_id: sf.id,
                drive_url: driveUrl,
                order_id: matchedOrder.id,
                order_contract: matchedOrder.moly_contract_number || matchedOrder.qb_po_doc_number,
                order_name: matchedOrder.contract_name,
                source_folder: folder.label,
              });
            } else {
              const { error: updateErr } = await supabase
                .from('orders')
                .update({
                  google_drive_folder_id: sf.id,
                  google_drive_folder_url: driveUrl,
                })
                .eq('id', matchedOrder.id);

              if (updateErr) {
                errors.push({ folder_name: folderName, order: matchedOrder.contract_name, error: updateErr.message });
              } else {
                // Mark as linked so we don't double-match
                matchedOrder.google_drive_folder_id = sf.id;
                matched++;
                results.push({
                  action: 'linked',
                  folder_name: folderName,
                  folder_id: sf.id,
                  order_contract: matchedOrder.moly_contract_number || matchedOrder.qb_po_doc_number,
                  order_name: matchedOrder.contract_name,
                  source_folder: folder.label,
                });
              }
            }
          } else if (!matchedOrder) {
            unmatched++;
            results.push({
              action: 'no_match',
              folder_name: folderName,
              folder_id: sf.id,
              source_folder: folder.label,
            });
          }
        }
      }
    }

    return new Response(JSON.stringify({
      success: true,
      dry_run: dryRun,
      matched,
      unmatched,
      errors: errors.length,
      results,
      error_details: errors,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
