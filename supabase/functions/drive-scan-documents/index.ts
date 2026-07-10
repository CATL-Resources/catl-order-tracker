// drive-scan-documents v7 — Better QB doc + signed + contract pattern matching
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };

function matchFileToSlot(fileName: string, contractNum: string | null): string | null {
  const lower = fileName.toLowerCase();
  if (!lower.endsWith(".pdf") && !lower.endsWith(".png") && !lower.endsWith(".jpg") && !lower.endsWith(".jpeg")) return null;

  // QB prefix docs — strongest signal (Tim names QB exports "QB Estimate", "QB PO", "QB Invoice", "QB Bill")
  if (/\bqb\s*estimate/i.test(fileName)) return "approved_estimate";
  if (/\bqb\s*po\b/i.test(fileName) || /\bqb\s*purchase/i.test(fileName)) return "catl_purchase_order";
  if (/\bqb\s*invoice/i.test(fileName)) return "catl_customer_invoice";
  if (/\bqb\s*bill/i.test(fileName)) return "qb_bill";

  // SIGNED: contains "signed" + contract number or SO keywords
  if (/signed/i.test(fileName)) {
    if (contractNum && lower.includes(contractNum.toLowerCase())) return "signed_sales_order";
    if (/sales\s*order|\bSO\b/i.test(fileName)) return "signed_sales_order";
    return "signed_sales_order";
  }

  // WEB ORDER: "web order" in name, or CATL+digits only (no other keywords)
  if (/web\s*order/i.test(fileName)) return "mfg_web_order";
  if (/^catl\d+\.pdf$/i.test(fileName) || /^catl\/catl\d+\.pdf$/i.test(fileName)) return "mfg_web_order";

  // MFG INVOICE: Moly invoice patterns (SO_...IN_ or padded contract number + IN)
  if (/_SO_.*IN_/i.test(fileName) || /_SO_\d+IN/i.test(fileName)) return "mfg_invoice";
  if (contractNum) {
    const paddedNum = contractNum.padStart(7, "0");
    if (lower.includes(paddedNum.toLowerCase() + "in")) return "mfg_invoice";
  }

  // MFG SALES ORDER: "contract" + contract number, or "sales order", or CATL+digits+name+contract
  if (/contract/i.test(fileName) && contractNum && lower.includes(contractNum.toLowerCase())) return "mfg_sales_order";
  if (/sales\s*order/i.test(fileName) || /\bSO\b[\s_-]*\d/i.test(fileName)) return "mfg_sales_order";

  // Generic "invoice" (not QB, not customer) = mfg invoice
  if (/invoice/i.test(fileName) && !/customer/i.test(fileName) && !/\bqb\b/i.test(fileName)) return "mfg_invoice";

  // ESTIMATE / QUOTE
  if (/estimate/i.test(fileName) || /quote/i.test(fileName)) return "approved_estimate";

  // PURCHASE ORDER / PO
  if (/purchase.*order/i.test(fileName) || /\bPO\b/i.test(fileName)) return "catl_purchase_order";

  // BILL
  if (/\bbill\b/i.test(fileName)) return "qb_bill";

  // CUSTOMER INVOICE
  if (/customer.*invoice/i.test(fileName)) return "catl_customer_invoice";

  // Contract number in filename with keyword hints
  if (contractNum && lower.includes(contractNum.toLowerCase())) {
    if (lower.includes("web")) return "mfg_web_order";
    if (lower.includes("so") || lower.includes("sales")) return "mfg_sales_order";
    if (lower.includes("inv")) return "mfg_invoice";
    if (lower.includes("po") || lower.includes("purchase")) return "catl_purchase_order";
    if (lower.includes("est") || lower.includes("quote")) return "approved_estimate";
    if (lower.includes("bill")) return "qb_bill";
    // CATL + long digits + contract = mfg sales order (the printed spec)
    if (/catl\d{8,}/i.test(fileName)) return "mfg_sales_order";
    // Has CATL + contract number but no other keywords = likely the CATL estimate/quote
    if (/catl/i.test(fileName)) return "catl_estimate";
  }
  return null;
}

async function getGoogleToken(supabase: any): Promise<string> {
  const { data: t } = await supabase.from("google_tokens").select("*").limit(1).single();
  if (!t) throw new Error("Google not connected");
  if (new Date(t.access_token_expires_at) < new Date()) {
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: Deno.env.get("GOOGLE_CLIENT_ID") || "", client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") || "", refresh_token: t.refresh_token, grant_type: "refresh_token" }),
    });
    if (!resp.ok) throw new Error("Google token refresh failed");
    const tokens = await resp.json();
    await supabase.from("google_tokens").update({ access_token: tokens.access_token, access_token_expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString() }).eq("id", t.id);
    return tokens.access_token;
  }
  return t.access_token;
}

const SLOT_LABELS: Record<string, string> = {
  catl_estimate: "CATL Estimate", approved_estimate: "Approved Estimate",
  catl_purchase_order: "CATL Purchase Order", mfg_web_order: "Mfg Web Order",
  mfg_sales_order: "Mfg Sales Order", signed_sales_order: "Signed Sales Order",
  mfg_invoice: "Mfg Invoice", qb_bill: "QB Bill",
  catl_customer_invoice: "Customer Invoice",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { order_id } = await req.json();
    if (!order_id) return new Response(JSON.stringify({ success: false, error: "order_id required" }), { status: 200, headers: corsHeaders });

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: order } = await supabase.from("orders")
      .select("id, google_drive_folder_id, google_drive_folder_url, moly_contract_number, contract_name, order_number")
      .eq("id", order_id).single();
    if (!order) return new Response(JSON.stringify({ success: false, error: "Order not found" }), { status: 200, headers: corsHeaders });

    let folderId = order.google_drive_folder_id;
    if (!folderId && order.google_drive_folder_url) {
      const match = order.google_drive_folder_url.match(/folders\/([a-zA-Z0-9_-]+)/);
      if (match) folderId = match[1];
    }
    if (!folderId) return new Response(JSON.stringify({ success: false, error: "No Drive folder linked" }), { status: 200, headers: corsHeaders });

    const googleToken = await getGoogleToken(supabase);
    const contractNum = order.moly_contract_number || order.order_number;

    const listUrl = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&fields=files(id,name,mimeType,webViewLink,size,createdTime)&pageSize=100`;
    const listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${googleToken}` } });
    if (!listResp.ok) return new Response(JSON.stringify({ success: false, error: `Drive list failed: ${listResp.status}` }), { status: 200, headers: corsHeaders });
    const files = (await listResp.json()).files || [];

    const subFolders = files.filter((f: any) => f.mimeType === "application/vnd.google-apps.folder");
    const allFiles = files.filter((f: any) => f.mimeType !== "application/vnd.google-apps.folder");
    for (const sub of subFolders) {
      const subUrl = `https://www.googleapis.com/drive/v3/files?q='${sub.id}'+in+parents+and+trashed=false&fields=files(id,name,mimeType,webViewLink,size,createdTime)&pageSize=50`;
      const subResp = await fetch(subUrl, { headers: { Authorization: `Bearer ${googleToken}` } });
      if (subResp.ok) { const subFiles = (await subResp.json()).files || []; allFiles.push(...subFiles.map((f: any) => ({ ...f, subfolder: sub.name }))); }
    }

    const { data: slots } = await supabase.from("order_document_slots")
      .select("id, slot_type, is_filled, document_id").eq("order_id", order_id);

    const filled: string[] = []; const updated: string[] = [];
    const unmatched_files: { id: string; name: string; url: string; size: string; suggested_slot?: string }[] = [];
    const alreadyFilled: string[] = [];

    for (const file of allFiles) {
      if (file.mimeType === "application/vnd.google-apps.folder") continue;
      const fileUrl = file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`;
      const slotType = matchFileToSlot(file.name, contractNum);

      if (!slotType) { unmatched_files.push({ id: file.id, name: file.name, url: fileUrl, size: file.size || "0" }); continue; }
      const slot = slots?.find((s: any) => s.slot_type === slotType);
      if (!slot) { unmatched_files.push({ id: file.id, name: file.name, url: fileUrl, size: file.size || "0", suggested_slot: slotType }); continue; }

      if (slot.document_id) {
        const { data: existingDoc } = await supabase.from("order_documents").select("id, file_url, file_name").eq("id", slot.document_id).single();
        if (existingDoc?.file_url) { alreadyFilled.push(`${SLOT_LABELS[slotType] || slotType}: already linked`); continue; }
        if (existingDoc) {
          await supabase.from("order_documents").update({ file_url: fileUrl, file_name: existingDoc.file_name || file.name, file_type: file.mimeType || "application/pdf", file_size_bytes: parseInt(file.size || "0"), source: "drive" }).eq("id", existingDoc.id);
          if (!slot.is_filled) await supabase.from("order_document_slots").update({ is_filled: true, filled_at: new Date().toISOString(), parsed_by: "drive_scan", comparison_status: "pending", updated_at: new Date().toISOString() }).eq("id", slot.id);
          updated.push(`${SLOT_LABELS[slotType] || slotType}: updated with Drive link`); continue;
        }
      }

      const { data: docRecord } = await supabase.from("order_documents").insert({
        order_id, document_type: slotType, title: file.name, description: `Matched from Drive: ${file.name}`,
        file_url: fileUrl, file_name: file.name, file_type: file.mimeType || "application/pdf",
        file_size_bytes: parseInt(file.size || "0"), source: "drive", manufacturer_ref: contractNum || null, is_unmatched: false,
      }).select("id").single();
      if (docRecord) {
        await supabase.from("order_document_slots").update({ is_filled: true, filled_at: new Date().toISOString(), document_id: docRecord.id, parsed_by: "drive_scan", comparison_status: "pending", updated_at: new Date().toISOString() }).eq("order_id", order_id).eq("slot_type", slotType);
        filled.push(`${SLOT_LABELS[slotType] || slotType}: ${file.name}`);
      }
    }

    const totalActions = filled.length + updated.length;
    const summary = totalActions > 0 ? `${filled.length} new, ${updated.length} updated: ${[...filled, ...updated].join("; ")}` : allFiles.length === 0 ? "Drive folder is empty" : `${allFiles.length} file(s) found, ${unmatched_files.length} unmatched`;
    return new Response(JSON.stringify({ success: true, summary, files_in_folder: allFiles.length, matched: filled.length, updated: updated.length, filled, updated, unmatched_files, already_filled: alreadyFilled }), { status: 200, headers: corsHeaders });
  } catch (err: any) {
    console.error("drive-scan-documents error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 200, headers: corsHeaders });
  }
});
