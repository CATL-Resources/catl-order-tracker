import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') || '';

// Manufacturer year folders in Drive
const DRIVE_FOLDERS: Record<string, { manufacturer_id: string; folder_id: string; label: string }[]> = {
  moly: [
    { manufacturer_id: 'b5cf513b-c38b-443e-bd13-8b2e79e1ccb6', folder_id: '1XbMvfvbnR0PgOUeXqY0JCuHwqBwgOxrX', label: 'SILENCER 2026' },
    { manufacturer_id: 'b5cf513b-c38b-443e-bd13-8b2e79e1ccb6', folder_id: '1GW2IZELTNmBNup9qdoKZqdBnDc6Z-Mn6', label: 'SILENCER 2025' },
  ],
  daniels: [
    { manufacturer_id: '15e8fe09-0653-4282-ad34-1c9c24eb0f59', folder_id: '1vXPiyREiR1Bwvuy8SJKRndJUSVyHY592', label: 'Daniels 2026' },
    { manufacturer_id: '15e8fe09-0653-4282-ad34-1c9c24eb0f59', folder_id: '1MevH9MCkq15jxRcIsKlztb6bUCI_H8si', label: 'DANIELS 2025' },
  ],
  rawhide: [
    { manufacturer_id: '6bd9b7c0-c4e7-4d8b-be06-e1f2271fe12a', folder_id: '1V8WzsJapJuwzg3GEmIhqqn2gt9uHN7c7', label: 'RAWHIDE' },
  ],
  mje: [
    { manufacturer_id: 'b5163075-9b86-42b9-a7bb-aae43159e420', folder_id: '1oX4G4SMtRgYivBIVDv_AlvNyQEJ9MsXZ', label: 'MJE' },
  ],
};

async function refreshGoogleToken(supabase: any): Promise<string | null> {
  const { data: tokenRow } = await supabase
    .from('google_tokens')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();

  if (!tokenRow) return null;

  // Check if token is still valid (with 5 min buffer)
  const expiresAt = new Date(tokenRow.access_token_expires_at).getTime();
  if (Date.now() < expiresAt - 300000) {
    return tokenRow.access_token;
  }

  // Refresh
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: tokenRow.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  const data = await resp.json();
  if (!data.access_token) return null;

  const newExpiry = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
  await supabase
    .from('google_tokens')
    .update({
      access_token: data.access_token,
      access_token_expires_at: newExpiry,
    })
    .eq('id', tokenRow.id);

  return data.access_token;
}

async function listDriveSubfolders(accessToken: string, parentFolderId: string): Promise<any[]> {
  const query = `'${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,webViewLink)&pageSize=200`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.files || [];
}

async function listDriveFiles(accessToken: string, folderId: string): Promise<any[]> {
  const query = `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,webViewLink,webContentLink,size)&pageSize=100`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.files || [];
}

function extractContractNumber(folderName: string): string | null {
  // Pattern: "Contract 44520 – ..." or "Contract 44520 - ..." or just starts with a number
  const match = folderName.match(/(?:Contract\s+)?(\d{4,5})(?:\s*[–\-]|$)/i);
  if (match) return match[1];
  // Also try matching customer-name style like "2026 - McCrory" or "2026-Kjerstad"
  const custMatch = folderName.match(/^(\d{4}\s*-\s*\w+)/i);
  if (custMatch) return custMatch[1].trim();
  return null;
}

function classifyDocument(fileName: string): { slot_type: string; doc_type: string } | null {
  const lower = fileName.toLowerCase();
  if (lower.includes('sales order') || lower.includes('sales_order') || lower.includes(' so ') || lower.match(/\bso\b/)) {
    return { slot_type: 'moly_so', doc_type: 'Sales Order' };
  }
  if (lower.includes('invoice') && !lower.includes('catl')) {
    return { slot_type: 'moly_invoice', doc_type: 'Invoice' };
  }
  if (lower.includes('purchase order') || lower.includes('purchase_order') || lower.match(/\bpo\b/)) {
    return { slot_type: 'catl_po', doc_type: 'Purchase Order' };
  }
  if (lower.includes('estimate') || lower.includes('quote')) {
    return { slot_type: 'catl_estimate', doc_type: 'Estimate' };
  }
  if (lower.includes('bill')) {
    return { slot_type: 'qb_bill', doc_type: 'Bill' };
  }
  return null; // Unclassified
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

    // Get Google token
    const accessToken = await refreshGoogleToken(supabase);
    if (!accessToken) {
      return new Response(JSON.stringify({ success: false, error: 'Could not get Google access token. Tim may need to re-authorize.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Get all orders that need folder linking
    const { data: orders } = await supabase
      .from('orders')
      .select('id, moly_contract_number, qb_po_doc_number, contract_name, manufacturer_id, google_drive_folder_id')
      .is('google_drive_folder_id', null);

    if (!orders || orders.length === 0) {
      return new Response(JSON.stringify({ success: true, message: 'All orders already have Drive folders linked' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Build lookup maps for orders
    const ordersByContract = new Map<string, any>();
    for (const order of orders) {
      if (order.moly_contract_number) {
        ordersByContract.set(order.moly_contract_number, order);
      }
      if (order.qb_po_doc_number && order.qb_po_doc_number !== order.moly_contract_number) {
        ordersByContract.set(order.qb_po_doc_number, order);
      }
    }

    const results: any[] = [];
    const allFolderSources = Object.values(DRIVE_FOLDERS).flat();

    for (const source of allFolderSources) {
      const subfolders = await listDriveSubfolders(accessToken, source.folder_id);

      for (const folder of subfolders) {
        const contractNum = extractContractNumber(folder.name);
        if (!contractNum) continue;

        const order = ordersByContract.get(contractNum);
        if (!order) continue;

        // Found a match!
        const folderUrl = folder.webViewLink || `https://drive.google.com/drive/folders/${folder.id}`;

        // List files inside
        const files = await listDriveFiles(accessToken, folder.id);
        const classifiedFiles = files.map((f: any) => {
          const classification = classifyDocument(f.name);
          return {
            file_id: f.id,
            file_name: f.name,
            mime_type: f.mimeType,
            web_view_link: f.webViewLink,
            ...classification,
          };
        });

        if (dryRun) {
          results.push({
            action: 'would_link',
            order_id: order.id,
            contract: contractNum,
            contract_name: order.contract_name,
            drive_folder: folder.name,
            drive_folder_id: folder.id,
            drive_source: source.label,
            files_found: files.length,
            classified_files: classifiedFiles,
          });
        } else {
          // Update order with Drive folder
          await supabase
            .from('orders')
            .update({
              google_drive_folder_id: folder.id,
              google_drive_folder_url: folderUrl,
            })
            .eq('id', order.id);

          // Create order_documents entries and fill document slots
          let docsCreated = 0;
          let slotsFilled = 0;

          for (const file of classifiedFiles) {
            const fileUrl = file.web_view_link || `https://drive.google.com/file/d/${file.file_id}/view`;

            // Create document record
            const { data: doc } = await supabase
              .from('order_documents')
              .insert({
                order_id: order.id,
                document_type: file.doc_type || 'Other',
                title: file.file_name,
                file_url: fileUrl,
                file_name: file.file_name,
                file_type: file.mime_type === 'application/pdf' ? 'pdf' : 'other',
                source: 'drive_scan',
                created_by: 'system',
              })
              .select('id')
              .single();

            if (doc) docsCreated++;

            // Fill document slot if we know the type
            if (file.slot_type && doc) {
              const { error: slotErr } = await supabase
                .from('order_document_slots')
                .update({
                  is_filled: true,
                  filled_at: new Date().toISOString(),
                  document_id: doc.id,
                })
                .eq('order_id', order.id)
                .eq('slot_type', file.slot_type)
                .eq('is_filled', false);

              if (!slotErr) slotsFilled++;
            }
          }

          // Timeline entry
          await supabase.from('order_timeline').insert({
            order_id: order.id,
            event_type: 'drive_linked',
            title: 'Google Drive folder linked',
            description: `Matched folder "${folder.name}" with ${files.length} files. ${docsCreated} documents imported, ${slotsFilled} slots filled.`,
            created_by: 'system',
          });

          results.push({
            action: 'linked',
            order_id: order.id,
            contract: contractNum,
            contract_name: order.contract_name,
            drive_folder: folder.name,
            files_found: files.length,
            docs_created: docsCreated,
            slots_filled: slotsFilled,
          });
        }

        // Remove from map so we don't double-match
        ordersByContract.delete(contractNum);
      }
    }

    // Report unmatched orders
    const unmatched = orders
      .filter(o => !results.find(r => r.order_id === o.id))
      .map(o => ({
        order_id: o.id,
        contract: o.moly_contract_number || o.qb_po_doc_number,
        contract_name: o.contract_name,
      }));

    return new Response(JSON.stringify({
      success: true,
      dry_run: dryRun,
      matched: results.length,
      unmatched: unmatched.length,
      results,
      unmatched_orders: unmatched,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
