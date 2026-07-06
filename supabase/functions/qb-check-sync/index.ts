// qb-check-sync v10 — Fixed: correct document_type, fills slot properly, 8-slot chain
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version"
};

async function getQBToken(supabase: any) {
  const { data: tokenRow } = await supabase.from("qb_tokens").select("*").limit(1).single();
  if (!tokenRow) throw new Error("QuickBooks not connected");
  if (new Date(tokenRow.access_token_expires_at) > new Date()) return tokenRow;
  const resp = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${Deno.env.get("QB_CLIENT_ID")}:${Deno.env.get("QB_CLIENT_SECRET")}`)}` },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokenRow.refresh_token })
  });
  if (!resp.ok) throw new Error(`Token refresh failed: ${await resp.text()}`);
  const tokens = await resp.json();
  const now = new Date();
  await supabase.from("qb_tokens").update({
    access_token: tokens.access_token, refresh_token: tokens.refresh_token,
    access_token_expires_at: new Date(now.getTime() + tokens.expires_in * 1000).toISOString(),
    refresh_token_expires_at: new Date(now.getTime() + (tokens.x_refresh_token_expires_in || 8726400) * 1000).toISOString(),
    updated_at: now.toISOString()
  }).eq("id", tokenRow.id);
  return { ...tokenRow, access_token: tokens.access_token };
}

async function fetchQBEntity(baseUrl: string, realmId: string, accessToken: string, entityType: string, entityId: string): Promise<any | null> {
  const resp = await fetch(`${baseUrl}/v3/company/${realmId}/${entityType}/${entityId}?minorversion=75`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  if (resp.status === 429) throw new Error(`QB ${entityType} 429`);
  if (!resp.ok) return null;
  const data = await resp.json();
  const key = Object.keys(data).find(k => k.toLowerCase() === entityType.toLowerCase());
  return key ? data[key] : null;
}

async function queryQBEntity(baseUrl: string, realmId: string, accessToken: string, query: string): Promise<any[]> {
  const resp = await fetch(`${baseUrl}/v3/company/${realmId}/query?query=${encodeURIComponent(query)}&minorversion=75`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  if (!resp.ok) return [];
  const data = await resp.json(); const qr = data?.QueryResponse; if (!qr) return [];
  for (const v of Object.values(qr)) { if (Array.isArray(v)) return v; }
  return [];
}

async function downloadQBPdf(baseUrl: string, realmId: string, accessToken: string, entityType: string, entityId: string): Promise<{ data: ArrayBuffer; contentType: string } | null> {
  const resp = await fetch(`${baseUrl}/v3/company/${realmId}/${entityType}/${entityId}/pdf?minorversion=75`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/pdf" } });
  if (resp.status === 429) throw new Error(`QB PDF 429`);
  if (!resp.ok) return null;
  return { data: await resp.arrayBuffer(), contentType: resp.headers.get("content-type") || "application/pdf" };
}

async function uploadToGoogleDrive(supabase: any, pdfBuffer: ArrayBuffer, filename: string, folderId: string): Promise<string | null> {
  try {
    const { data: gToken } = await supabase.from("google_tokens").select("access_token, access_token_expires_at, refresh_token").limit(1).single();
    if (!gToken) return null;
    let accessToken = gToken.access_token;
    if (new Date(gToken.access_token_expires_at) <= new Date()) {
      const refreshResp = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: Deno.env.get("GOOGLE_CLIENT_ID") || "", client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") || "", refresh_token: gToken.refresh_token, grant_type: "refresh_token" }) });
      if (!refreshResp.ok) return null;
      const refreshData = await refreshResp.json();
      accessToken = refreshData.access_token;
      await supabase.from("google_tokens").update({ access_token: accessToken, access_token_expires_at: new Date(Date.now() + (refreshData.expires_in || 3600) * 1000).toISOString() }).limit(1);
    }
    const metadata = JSON.stringify({ name: filename, mimeType: "application/pdf", parents: [folderId] });
    const boundary = "----FormBoundary" + Date.now();
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`;
    const encoder = new TextEncoder(); const prefix = encoder.encode(body); const suffix = encoder.encode(`\r\n--${boundary}--`);
    const pdfBytes = new Uint8Array(pdfBuffer);
    const fullBody = new Uint8Array(prefix.length + pdfBytes.length + suffix.length);
    fullBody.set(prefix, 0); fullBody.set(pdfBytes, prefix.length); fullBody.set(suffix, prefix.length + pdfBytes.length);
    const uploadResp = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body: fullBody });
    if (!uploadResp.ok) return null;
    const uploadData = await uploadResp.json();
    return uploadData.webViewLink || `https://drive.google.com/file/d/${uploadData.id}/view`;
  } catch { return null; }
}

function extractFolderId(url: string): string | null { const match = url.match(/folders\/([a-zA-Z0-9_-]+)/); return match ? match[1] : null; }

// Download QB PDF, upload to Drive, create doc record, fill slot
async function downloadAndFillSlot(
  supabase: any, baseUrl: string, realmId: string, accessToken: string,
  orderId: string, folderId: string | null,
  qbEntityType: string, qbEntityId: string, docNumber: string,
  slotType: string, pdfLabel: string
): Promise<{ success: boolean; file_url?: string; already_filled?: boolean; error?: string }> {
  // Check if slot already filled
  const { data: slot } = await supabase.from("order_document_slots").select("id, document_id, is_filled").eq("order_id", orderId).eq("slot_type", slotType).single();
  if (!slot) return { success: false, error: `No ${slotType} slot found` };
  if (slot.document_id) return { success: true, already_filled: true };

  try {
    const pdf = await downloadQBPdf(baseUrl, realmId, accessToken, qbEntityType, qbEntityId);
    if (!pdf) return { success: false, error: "PDF download failed" };

    let fileUrl: string | null = null;
    const pdfFilename = `${pdfLabel} ${docNumber}.pdf`;

    if (folderId) fileUrl = await uploadToGoogleDrive(supabase, pdf.data, pdfFilename, folderId);
    if (!fileUrl) {
      const storagePath = `orders/${orderId}/${slotType}_${docNumber}.pdf`;
      const { error: uploadErr } = await supabase.storage.from("order-documents").upload(storagePath, pdf.data, { contentType: "application/pdf", upsert: true });
      if (!uploadErr) { const { data: pubUrl } = supabase.storage.from("order-documents").getPublicUrl(storagePath); fileUrl = pubUrl?.publicUrl || null; }
    }
    if (!fileUrl) return { success: false, error: "Upload failed (both Drive and Storage)" };

    const { data: docRecord } = await supabase.from("order_documents").insert({
      order_id: orderId, document_type: slotType, title: pdfFilename, description: `Downloaded from QuickBooks: ${pdfFilename}`,
      file_url: fileUrl, file_name: pdfFilename, file_type: "application/pdf", source: "quickbooks", is_unmatched: false,
    }).select("id").single();
    if (!docRecord) return { success: false, error: "Document record insert failed" };

    await supabase.from("order_document_slots").update({
      document_id: docRecord.id, is_filled: true, filled_at: new Date().toISOString(),
      parsed_by: "qb_sync", comparison_status: "pending", updated_at: new Date().toISOString(),
    }).eq("id", slot.id);

    return { success: true, file_url: fileUrl };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { order_id } = await req.json();
    if (!order_id) return new Response(JSON.stringify({ error: "order_id required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: order, error: ordErr } = await supabase.from("orders").select("*, manufacturers(name, short_name)").eq("id", order_id).single();
    if (ordErr || !order) throw new Error(`Order not found: ${ordErr?.message}`);

    const tokenData = await getQBToken(supabase);
    const { access_token, realm_id } = tokenData;
    const baseUrl = Deno.env.get("QB_BASE_URL") || "https://quickbooks.api.intuit.com";
    const folderId = order.google_drive_folder_url ? extractFolderId(order.google_drive_folder_url) : null;

    const issues: string[] = []; const checks: Record<string, any> = {}; const downloads: Record<string, any> = {};

    // CHECK 1: CATL Purchase Order
    if (order.qb_po_id) {
      let po: any = null;
      try { po = await fetchQBEntity(baseUrl, realm_id, access_token, "purchaseorder", order.qb_po_id); } catch (e: any) { if (e.message?.includes("429")) { checks.catl_purchase_order = { found: false, error: "QB rate limited" }; issues.push("PO lookup rate limited"); } }
      if (!po && order.qb_po_doc_number) {
        const results = await queryQBEntity(baseUrl, realm_id, access_token, `SELECT * FROM PurchaseOrder WHERE DocNumber = '${order.qb_po_doc_number}' MAXRESULTS 1`);
        if (results.length > 0) { po = results[0]; if (po.Id !== order.qb_po_id) await supabase.from("orders").update({ qb_po_id: po.Id }).eq("id", order_id); }
      }
      if (!po && order.moly_contract_number && order.moly_contract_number !== order.qb_po_doc_number) {
        const results = await queryQBEntity(baseUrl, realm_id, access_token, `SELECT * FROM PurchaseOrder WHERE DocNumber = '${order.moly_contract_number}' MAXRESULTS 1`);
        if (results.length > 0) { po = results[0]; await supabase.from("orders").update({ qb_po_id: po.Id, qb_po_doc_number: po.DocNumber }).eq("id", order_id); }
      }
      if (po) {
        checks.catl_purchase_order = { found: true, doc_number: po.DocNumber, qb_id: po.Id, total: po.TotalAmt };
        downloads.catl_purchase_order = await downloadAndFillSlot(supabase, baseUrl, realm_id, access_token, order_id, folderId, "purchaseorder", po.Id, po.DocNumber, "catl_purchase_order", "QB PO");
      } else if (!checks.catl_purchase_order) {
        checks.catl_purchase_order = { found: false }; issues.push(`PO not found (ID:${order.qb_po_id})`);
      }
    }

    // CHECK 2: QB Estimate (for approved_estimate slot)
    if (order.qb_estimate_id) {
      let estimate: any = null;
      try { estimate = await fetchQBEntity(baseUrl, realm_id, access_token, "estimate", order.qb_estimate_id); } catch (e: any) { if (e.message?.includes("429")) checks.approved_estimate = { found: false, error: "QB rate limited" }; }
      if (estimate) {
        checks.approved_estimate = { found: true, doc_number: estimate.DocNumber, qb_id: estimate.Id, total: estimate.TotalAmt };
        downloads.approved_estimate = await downloadAndFillSlot(supabase, baseUrl, realm_id, access_token, order_id, folderId, "estimate", estimate.Id, estimate.DocNumber, "approved_estimate", "QB Estimate");
      } else if (!checks.approved_estimate) {
        checks.approved_estimate = { found: false }; issues.push(`Estimate not found (ID:${order.qb_estimate_id})`);
      }
    }

    // CHECK 3: QB Bill
    if (order.qb_bill_id) {
      let bill: any = null;
      try { bill = await fetchQBEntity(baseUrl, realm_id, access_token, "bill", order.qb_bill_id); } catch (e: any) { if (e.message?.includes("429")) checks.qb_bill = { found: false, error: "QB rate limited" }; }
      if (bill) {
        checks.qb_bill = { found: true, doc_number: bill.DocNumber, qb_id: bill.Id, total: bill.TotalAmt };
        downloads.qb_bill = await downloadAndFillSlot(supabase, baseUrl, realm_id, access_token, order_id, folderId, "bill", bill.Id, bill.DocNumber || bill.Id, "qb_bill", "QB Bill");
      } else if (!checks.qb_bill) {
        checks.qb_bill = { found: false }; issues.push(`Bill not found (ID:${order.qb_bill_id})`);
      }
    }

    // CHECK 4: Customer Invoice
    if (order.qb_invoice_id) {
      let invoice: any = null;
      try { invoice = await fetchQBEntity(baseUrl, realm_id, access_token, "invoice", order.qb_invoice_id); } catch (e: any) { if (e.message?.includes("429")) checks.catl_customer_invoice = { found: false, error: "QB rate limited" }; }
      if (invoice) {
        checks.catl_customer_invoice = { found: true, doc_number: invoice.DocNumber, qb_id: invoice.Id, total: invoice.TotalAmt };
        downloads.catl_customer_invoice = await downloadAndFillSlot(supabase, baseUrl, realm_id, access_token, order_id, folderId, "invoice", invoice.Id, invoice.DocNumber, "catl_customer_invoice", "QB Invoice");
      } else if (!checks.catl_customer_invoice) {
        checks.catl_customer_invoice = { found: false }; issues.push(`Invoice not found (ID:${order.qb_invoice_id})`);
      }
    }

    const downloadCount = Object.values(downloads).filter((d: any) => d.success && !d.already_filled).length;
    const summary = issues.length > 0 ? `${issues.length} issue(s): ${issues.join("; ")}` : `Synced! ${downloadCount} PDF(s) downloaded.`;
    return new Response(JSON.stringify({ success: true, has_issues: issues.length > 0, summary, issues, checks, downloads }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
