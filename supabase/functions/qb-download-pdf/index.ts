import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

async function log(fn: string, step: string, msg: string) {
  console.log(`[${fn}] ${step}: ${msg}`);
  try { await supabase.from("debug_log").insert({ function_name: fn, step, message: msg.substring(0, 4000) }); } catch(_) {}
}

const MFG_DRIVE_FOLDERS: Record<string, Record<string, string>> = {
  "MOLY": { "2025": "1GW2IZELTNmBNup9qdoKZqdBnDc6Z-Mn6", "2026": "1XbMvfvbnR0PgOUeXqY0JCuHwqBwgOxrX" },
  "Daniels": { "2025": "1MevH9MCkq15jxRcIsKlztb6bUCI_H8si", "2026": "1vXPiyREiR1Bwvuy8SJKRndJUSVyHY592" },
  "Rawhide": { "all": "1V8WzsJapJuwzg3GEmIhqqn2gt9uHN7c7" },
  "MJE": { "all": "1oX4G4SMtRgYivBIVDv_AlvNyQEJ9MsXZ" },
};

const QB_PDF_ENDPOINTS: Record<string, string> = {
  "catl_estimate": "estimate",
  "catl_purchase_order": "purchaseorder",
  "qb_bill": "bill",
  "catl_customer_invoice": "invoice",
};

async function getGoogleToken(): Promise<string> {
  const { data: tokenRow } = await supabase.from("google_tokens").select("*").limit(1).single();
  if (!tokenRow) throw new Error("Google not connected");
  if (new Date(tokenRow.access_token_expires_at) < new Date()) {
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: tokenRow.refresh_token, grant_type: "refresh_token" }),
    });
    if (!resp.ok) throw new Error(`Google token refresh failed: ${await resp.text()}`);
    const tokens = await resp.json();
    await supabase.from("google_tokens").update({ access_token: tokens.access_token, access_token_expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(), updated_at: new Date().toISOString() }).eq("id", tokenRow.id);
    return tokens.access_token;
  }
  return tokenRow.access_token;
}

async function findOrCreateDriveFolder(googleToken: string, parentFolderId: string, folderName: string): Promise<string> {
  const searchQuery = `name='${folderName.replace(/'/g, "\\'")}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const searchResp = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(searchQuery)}&fields=files(id,name)`, { headers: { Authorization: `Bearer ${googleToken}` } });
  if (searchResp.ok) {
    const searchData = await searchResp.json();
    if (searchData.files && searchData.files.length > 0) return searchData.files[0].id;
  }
  const createResp = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST", headers: { Authorization: `Bearer ${googleToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: folderName, mimeType: "application/vnd.google-apps.folder", parents: [parentFolderId] }),
  });
  if (!createResp.ok) throw new Error(`Failed to create Drive folder: ${await createResp.text()}`);
  const folder = await createResp.json();
  return folder.id;
}

async function uploadToDrive(googleToken: string, folderId: string, fileName: string, pdfBytes: Uint8Array): Promise<{ fileId: string; webViewLink: string }> {
  const boundary = "----CATLBoundary" + Date.now();
  const metadata = JSON.stringify({ name: fileName, parents: [folderId], mimeType: "application/pdf" });
  const encoder = new TextEncoder();
  const parts = [
    encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    encoder.encode(`--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
    pdfBytes,
    encoder.encode(`\r\n--${boundary}--`),
  ];
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.length; }
  const uploadResp = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST", headers: { Authorization: `Bearer ${googleToken}`, "Content-Type": `multipart/related; boundary=${boundary}`, "Content-Length": String(totalLength) }, body: body,
  });
  if (!uploadResp.ok) throw new Error(`Drive upload failed: ${await uploadResp.text()}`);
  const fileData = await uploadResp.json();
  return { fileId: fileData.id, webViewLink: fileData.webViewLink || `https://drive.google.com/file/d/${fileData.id}/view` };
}

async function getQBToken(): Promise<{ access_token: string; realm_id: string }> {
  const { data: tokenRow } = await supabase.from("qb_tokens").select("*").limit(1).single();
  if (!tokenRow) throw new Error("QuickBooks not connected");
  if (new Date(tokenRow.access_token_expires_at) > new Date()) return tokenRow;
  const clientId = Deno.env.get("QB_CLIENT_ID")!;
  const clientSecret = Deno.env.get("QB_CLIENT_SECRET")!;
  const resp = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}` },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokenRow.refresh_token }),
  });
  if (!resp.ok) throw new Error(`QB token refresh failed: ${await resp.text()}`);
  const tokens = await resp.json();
  await supabase.from("qb_tokens").update({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, access_token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(), updated_at: new Date().toISOString() }).eq("id", tokenRow.id);
  return { ...tokenRow, access_token: tokens.access_token };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const FN = "qb-download-pdf";
  try {
    const { order_id, qb_doc_id, qb_doc_number, slot_type, doc_type_label } = await req.json();
    await log(FN, "start", `order=${order_id} doc=${qb_doc_id} slot=${slot_type}`);

    if (!order_id || !qb_doc_id || !slot_type) {
      await log(FN, "error", "Missing required params");
      return new Response(JSON.stringify({ success: false, error: "order_id, qb_doc_id, and slot_type required" }), { status: 200, headers: corsHeaders });
    }

    const qbEndpoint = QB_PDF_ENDPOINTS[slot_type];
    if (!qbEndpoint) {
      await log(FN, "error", `Unknown slot_type: ${slot_type}`);
      return new Response(JSON.stringify({ success: false, error: `Unknown slot_type: ${slot_type}` }), { status: 200, headers: corsHeaders });
    }

    const { data: order } = await supabase.from("orders").select("*, manufacturers(name, short_name)").eq("id", order_id).single();
    if (!order) {
      await log(FN, "error", "Order not found");
      return new Response(JSON.stringify({ success: false, error: "Order not found" }), { status: 200, headers: corsHeaders });
    }
    await log(FN, "order", `name=${order.contract_name} mfg=${order.manufacturers?.name}`);

    // Step 1: Download PDF from QuickBooks
    await log(FN, "qb_pdf", `Downloading ${qbEndpoint}/${qb_doc_id}`);
    const qbToken = await getQBToken();
    await log(FN, "qb_token", `realm=${qbToken.realm_id} token_len=${qbToken.access_token?.length}`);

    const pdfUrl = `https://quickbooks.api.intuit.com/v3/company/${qbToken.realm_id}/${qbEndpoint}/${qb_doc_id}/pdf?minorversion=73`;
    await log(FN, "qb_pdf_url", pdfUrl);

    const pdfResp = await fetch(pdfUrl, { headers: { Authorization: `Bearer ${qbToken.access_token}`, Accept: "application/pdf" } });
    if (!pdfResp.ok) {
      const errText = await pdfResp.text();
      await log(FN, "qb_pdf_error", `${pdfResp.status}: ${errText.substring(0, 500)}`);
      return new Response(JSON.stringify({ success: false, error: `QB PDF download failed: ${pdfResp.status}` }), { status: 200, headers: corsHeaders });
    }
    const pdfBuffer = await pdfResp.arrayBuffer();
    const pdfBytes = new Uint8Array(pdfBuffer);
    await log(FN, "qb_pdf_ok", `${pdfBytes.length} bytes downloaded`);

    // Step 2: Upload to Google Drive
    const googleToken = await getGoogleToken();
    await log(FN, "google_token", `token_len=${googleToken.length}`);

    const mfgShortName = order.manufacturers?.short_name || order.manufacturers?.name || "MOLY";
    const year = new Date().getFullYear().toString();
    const contractNum = order.mfg_contract_number || order.moly_contract_number || order.order_number || "unknown";
    const contractName = order.contract_name || contractNum;

    let parentFolderId: string | null = null;
    const mfgFolders = MFG_DRIVE_FOLDERS[mfgShortName];
    if (mfgFolders) parentFolderId = mfgFolders[year] || mfgFolders["all"] || null;
    if (!parentFolderId) { parentFolderId = MFG_DRIVE_FOLDERS["MOLY"]["2026"]; }
    await log(FN, "drive_folder", `mfg=${mfgShortName} year=${year} parent=${parentFolderId}`);

    const orderFolderName = `Contract ${contractNum} – ${contractName}`;
    const orderFolderId = await findOrCreateDriveFolder(googleToken, parentFolderId, orderFolderName);
    await log(FN, "drive_subfolder", `name=${orderFolderName} id=${orderFolderId}`);

    if (!order.google_drive_folder_id) {
      await supabase.from("orders").update({ google_drive_folder_id: orderFolderId, google_drive_folder_url: `https://drive.google.com/drive/folders/${orderFolderId}` }).eq("id", order_id);
    }

    // Step 3: Upload PDF
    const label = doc_type_label || slot_type.replace(/_/g, " ");
    const fileName = `${label} - ${qb_doc_number || qb_doc_id}.pdf`;
    await log(FN, "uploading", `file=${fileName} to folder=${orderFolderId}`);

    const { fileId, webViewLink } = await uploadToDrive(googleToken, orderFolderId, fileName, pdfBytes);
    await log(FN, "upload_ok", `fileId=${fileId} link=${webViewLink}`);

    // Step 4: Create order_documents record
    const { data: docRecord, error: docErr } = await supabase.from("order_documents").insert({
      order_id, document_type: slot_type, title: fileName,
      description: `QB ${label} #${qb_doc_number || qb_doc_id} — auto-captured`,
      file_url: webViewLink, file_name: fileName, file_type: "application/pdf",
      file_size_bytes: pdfBytes.length, source: "quickbooks",
      manufacturer_ref: contractNum, is_unmatched: false,
    }).select("id").single();

    if (docErr) {
      await log(FN, "doc_insert_error", `${docErr.message} | ${docErr.details} | ${docErr.hint}`);
      return new Response(JSON.stringify({ success: false, error: `Doc insert failed: ${docErr.message}` }), { status: 200, headers: corsHeaders });
    }
    await log(FN, "doc_created", `id=${docRecord?.id}`);

    // Step 5: Fill the document slot
    if (docRecord) {
      const { error: slotErr } = await supabase.from("order_document_slots").update({
        is_filled: true, filled_at: new Date().toISOString(), document_id: docRecord.id,
        qb_doc_id: qb_doc_id, qb_doc_number: qb_doc_number || null,
        parsed_by: "quickbooks", comparison_status: "pending", updated_at: new Date().toISOString(),
      }).eq("order_id", order_id).eq("slot_type", slot_type);

      if (slotErr) {
        await log(FN, "slot_update_error", `${slotErr.message}`);
      } else {
        await log(FN, "slot_filled", `${slot_type} for order ${order_id}`);
      }
    }

    await log(FN, "complete", `SUCCESS: ${fileName} -> Drive -> slot ${slot_type}`);
    return new Response(JSON.stringify({ success: true, drive_file_id: fileId, drive_link: webViewLink, drive_folder_id: orderFolderId, file_name: fileName, slot_filled: slot_type }), { status: 200, headers: corsHeaders });

  } catch (err: any) {
    await log(FN, "CRASH", `${err.message || String(err)}\n${err.stack || ""}`);
    return new Response(JSON.stringify({ success: false, error: err.message || String(err) }), { status: 200, headers: corsHeaders });
  }
});
