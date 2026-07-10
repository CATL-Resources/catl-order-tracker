// qb-void-document: Voids/deletes any QB document (PO, Bill, Invoice, Estimate)
// Handles all four document types with one function
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };

async function getQBToken(supabase: any) {
  const { data: tokenRow } = await supabase.from("qb_tokens").select("*").limit(1).single();
  if (!tokenRow) throw new Error("QuickBooks not connected");
  if (new Date(tokenRow.access_token_expires_at) > new Date()) return tokenRow;
  const clientId = Deno.env.get("QB_CLIENT_ID"); const clientSecret = Deno.env.get("QB_CLIENT_SECRET");
  const resp = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}` }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokenRow.refresh_token }) });
  if (!resp.ok) throw new Error(`Token refresh failed: ${await resp.text()}`);
  const tokens = await resp.json(); const now = new Date();
  await supabase.from("qb_tokens").update({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, access_token_expires_at: new Date(now.getTime() + tokens.expires_in * 1000).toISOString(), updated_at: now.toISOString() }).eq("id", tokenRow.id);
  return { ...tokenRow, access_token: tokens.access_token };
}

// QB document type configs
const DOC_CONFIGS: Record<string, {
  endpoint: string;
  entityName: string;
  canDelete: boolean;  // QB allows delete
  canVoid: boolean;    // QB allows void (status change)
  qbIdField: string;
  qbDocNumField: string;
  syncStatusField: string;
  label: string;
}> = {
  estimate: {
    endpoint: "estimate", entityName: "Estimate",
    canDelete: true, canVoid: false,
    qbIdField: "qb_estimate_id", qbDocNumField: "qb_estimate_doc_number",
    syncStatusField: "_estimate_", // handled separately on estimates table
    label: "Estimate",
  },
  purchaseorder: {
    endpoint: "purchaseorder", entityName: "PurchaseOrder",
    canDelete: true, canVoid: false,
    qbIdField: "qb_po_id", qbDocNumField: "qb_po_doc_number",
    syncStatusField: "qb_po_sync_status",
    label: "Purchase Order",
  },
  bill: {
    endpoint: "bill", entityName: "Bill",
    canDelete: true, canVoid: false,
    qbIdField: "qb_bill_id", qbDocNumField: "qb_bill_doc_number",
    syncStatusField: "qb_bill_sync_status",
    label: "Bill",
  },
  invoice: {
    endpoint: "invoice", entityName: "Invoice",
    canDelete: false, canVoid: true, // Invoices can only be voided, not deleted
    qbIdField: "qb_invoice_id", qbDocNumField: "qb_invoice_doc_number",
    syncStatusField: "qb_invoice_sync_status",
    label: "Invoice",
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { order_id, doc_type, action, estimate_id } = await req.json();
    // doc_type: 'estimate' | 'purchaseorder' | 'bill' | 'invoice'
    // action: 'void_in_qb' | 'delete_local_only'
    if (!order_id && !estimate_id) return new Response(JSON.stringify({ success: false, error: "order_id or estimate_id required" }), { status: 200, headers: corsHeaders });
    if (!doc_type) return new Response(JSON.stringify({ success: false, error: "doc_type required (estimate, purchaseorder, bill, invoice)" }), { status: 200, headers: corsHeaders });

    const config = DOC_CONFIGS[doc_type];
    if (!config) return new Response(JSON.stringify({ success: false, error: `Unknown doc_type: ${doc_type}` }), { status: 200, headers: corsHeaders });

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Get the QB ID
    let qbId: string | null = null;
    let qbDocNum: string | null = null;
    let orderId = order_id;

    if (doc_type === "estimate" && estimate_id) {
      const { data: est } = await supabase.from("estimates").select("*").eq("id", estimate_id).single();
      if (!est) return new Response(JSON.stringify({ success: false, error: "Estimate not found" }), { status: 200, headers: corsHeaders });
      qbId = est.qb_estimate_id;
      qbDocNum = est.qb_doc_number;
      orderId = est.order_id;
    } else {
      const { data: order } = await supabase.from("orders").select("*").eq("id", order_id).single();
      if (!order) return new Response(JSON.stringify({ success: false, error: "Order not found" }), { status: 200, headers: corsHeaders });
      qbId = (order as any)[config.qbIdField];
      qbDocNum = (order as any)[config.qbDocNumField];
    }

    if (!qbId) return new Response(JSON.stringify({ success: false, error: `No QB ${config.label} linked to this order` }), { status: 200, headers: corsHeaders });

    let voidedInQB = false;
    let qbAction = "none";

    if (action === "void_in_qb") {
      const tokenData = await getQBToken(supabase);
      const { access_token, realm_id } = tokenData;
      const baseUrl = "https://quickbooks.api.intuit.com";

      // Get current SyncToken
      const getResp = await fetch(`${baseUrl}/v3/company/${realm_id}/${config.endpoint}/${qbId}?minorversion=73`, {
        headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" }
      });

      if (getResp.ok) {
        const existing = await getResp.json();
        const entity = existing[config.entityName];
        const syncToken = entity?.SyncToken;

        if (config.canVoid) {
          // Void (for invoices) — sparse update with void operation
          const voidResp = await fetch(`${baseUrl}/v3/company/${realm_id}/${config.endpoint}?operation=void&minorversion=73`, {
            method: "POST",
            headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ Id: qbId, SyncToken: syncToken }),
          });
          if (voidResp.ok) { voidedInQB = true; qbAction = "voided"; }
          else { console.error(`QB void failed: ${voidResp.status} ${await voidResp.text()}`); }
        } else if (config.canDelete) {
          // Delete (for estimates, POs, bills)
          const delResp = await fetch(`${baseUrl}/v3/company/${realm_id}/${config.endpoint}?operation=delete&minorversion=73`, {
            method: "POST",
            headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ Id: qbId, SyncToken: syncToken }),
          });
          if (delResp.ok) { voidedInQB = true; qbAction = "deleted"; }
          else { console.error(`QB delete failed: ${delResp.status} ${await delResp.text()}`); }
        }
      } else if (getResp.status === 400 || getResp.status === 404) {
        // Already deleted in QB
        voidedInQB = true;
        qbAction = "already_gone";
      }
    }

    // Update sync status
    if (doc_type === "estimate" && estimate_id) {
      await supabase.from("estimates").update({
        qb_sync_status: voidedInQB ? "voided" : "deleted_locally",
      }).eq("id", estimate_id);
    } else if (order_id) {
      const updateFields: any = {};
      updateFields[config.syncStatusField] = voidedInQB ? "voided" : "deleted_locally";
      // Clear the QB IDs so the doc can be re-pushed later
      if (voidedInQB) {
        updateFields[config.qbIdField] = null;
        updateFields[config.qbDocNumField] = null;
      }
      await supabase.from("orders").update(updateFields).eq("id", order_id);
    }

    // Timeline entry
    if (orderId) {
      await supabase.from("order_timeline").insert({
        order_id: orderId,
        event_type: "qb_document_voided",
        title: `${config.label} ${voidedInQB ? qbAction : "removed locally"} ${qbDocNum ? `#${qbDocNum}` : ""}`,
        description: voidedInQB
          ? `QB ${config.label} #${qbDocNum || qbId} ${qbAction} in QuickBooks and removed from app`
          : `QB ${config.label} #${qbDocNum || qbId} removed from app. Still exists in QuickBooks.`,
        created_by: "system",
      });
    }

    return new Response(JSON.stringify({
      success: true,
      voided_in_qb: voidedInQB,
      qb_action: qbAction,
      doc_type,
      qb_id: qbId,
      qb_doc_number: qbDocNum,
    }), { status: 200, headers: corsHeaders });

  } catch (err: any) {
    console.error("qb-void-document error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message || String(err) }), { status: 200, headers: corsHeaders });
  }
});
