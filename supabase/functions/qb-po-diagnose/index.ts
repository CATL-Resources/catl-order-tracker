import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };

async function getQBToken(supabase: any) {
  const { data: t } = await supabase.from("qb_tokens").select("*").limit(1).single();
  if (!t) throw new Error("QB not connected");
  if (new Date(t.access_token_expires_at) > new Date()) return t;
  const cid = Deno.env.get("QB_CLIENT_ID"), cs = Deno.env.get("QB_CLIENT_SECRET");
  const r = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${cid}:${cs}`)}` },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token })
  });
  if (!r.ok) throw new Error(`Token refresh failed: ${await r.text()}`);
  const tk = await r.json(); const now = new Date();
  await supabase.from("qb_tokens").update({ access_token: tk.access_token, refresh_token: tk.refresh_token, access_token_expires_at: new Date(now.getTime() + tk.expires_in * 1000).toISOString(), refresh_token_expires_at: new Date(now.getTime() + (tk.x_refresh_token_expires_in || 8726400) * 1000).toISOString(), updated_at: now.toISOString() }).eq("id", t.id);
  return { ...t, access_token: tk.access_token };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const body = await req.json();
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { access_token, realm_id } = await getQBToken(supabase);
    const base = Deno.env.get("QB_BASE_URL") || "https://quickbooks.api.intuit.com";

    const results: any[] = [];

    // Mode 1: diagnose a specific order
    if (body.order_id) {
      const { data: order } = await supabase.from("orders").select("id, moly_contract_number, contract_name, qb_po_id, qb_po_doc_number").eq("id", body.order_id).single();
      if (!order) return new Response(JSON.stringify({ error: "Order not found" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });

      const diag: any = { order: order.contract_name, stored_id: order.qb_po_id, stored_doc: order.qb_po_doc_number };

      // Try 1: direct ID lookup
      if (order.qb_po_id) {
        const r1 = await fetch(`${base}/v3/company/${realm_id}/purchaseorder/${order.qb_po_id}?minorversion=75`, { headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" } });
        diag.id_lookup_status = r1.status;
        if (r1.ok) {
          const d = await r1.json();
          diag.id_lookup = { found: true, Id: d.PurchaseOrder.Id, DocNumber: d.PurchaseOrder.DocNumber, VendorName: d.PurchaseOrder.VendorRef?.name, TotalAmt: d.PurchaseOrder.TotalAmt };
        } else {
          diag.id_lookup = { found: false, error: (await r1.text()).substring(0, 200) };
        }
      }

      // Try 2: query by doc number
      if (order.qb_po_doc_number) {
        const q = `SELECT * FROM PurchaseOrder WHERE DocNumber = '${order.qb_po_doc_number}' MAXRESULTS 5`;
        const r2 = await fetch(`${base}/v3/company/${realm_id}/query?query=${encodeURIComponent(q)}&minorversion=75`, { headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" } });
        diag.doc_query_status = r2.status;
        if (r2.ok) {
          const d = await r2.json();
          const pos = d.QueryResponse?.PurchaseOrder || [];
          diag.doc_query = { found: pos.length > 0, count: pos.length, results: pos.map((p: any) => ({ Id: p.Id, DocNumber: p.DocNumber, VendorName: p.VendorRef?.name, TotalAmt: p.TotalAmt })) };
        } else {
          diag.doc_query = { found: false, error: (await r2.text()).substring(0, 200) };
        }
      }

      // Try 3: query by moly contract number (might be different from doc number)
      if (order.moly_contract_number && order.moly_contract_number !== order.qb_po_doc_number) {
        const q = `SELECT * FROM PurchaseOrder WHERE DocNumber = '${order.moly_contract_number}' MAXRESULTS 5`;
        const r3 = await fetch(`${base}/v3/company/${realm_id}/query?query=${encodeURIComponent(q)}&minorversion=75`, { headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" } });
        if (r3.ok) {
          const d = await r3.json();
          const pos = d.QueryResponse?.PurchaseOrder || [];
          diag.moly_query = { found: pos.length > 0, count: pos.length, results: pos.map((p: any) => ({ Id: p.Id, DocNumber: p.DocNumber, VendorName: p.VendorRef?.name, TotalAmt: p.TotalAmt })) };
        }
      }

      // Try 4: look it up as a different entity type (Bill)
      if (order.qb_po_id) {
        const r4 = await fetch(`${base}/v3/company/${realm_id}/bill/${order.qb_po_id}?minorversion=75`, { headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" } });
        diag.bill_lookup_status = r4.status;
        if (r4.ok) {
          const d = await r4.json();
          diag.bill_lookup = { found: true, Id: d.Bill.Id, DocNumber: d.Bill.DocNumber, VendorName: d.Bill.VendorRef?.name, TotalAmt: d.Bill.TotalAmt };
        } else {
          diag.bill_lookup = { found: false };
        }
      }

      results.push(diag);
    }

    // Mode 2: list all POs in QB for a broad search
    if (body.list_all) {
      const limit = body.limit || 20;
      const q = `SELECT Id, DocNumber, VendorRef, TotalAmt, TxnDate FROM PurchaseOrder ORDERBY TxnDate DESC MAXRESULTS ${limit}`;
      const r = await fetch(`${base}/v3/company/${realm_id}/query?query=${encodeURIComponent(q)}&minorversion=75`, { headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" } });
      if (r.ok) {
        const d = await r.json();
        const pos = d.QueryResponse?.PurchaseOrder || [];
        return new Response(JSON.stringify({ success: true, count: pos.length, purchase_orders: pos.map((p: any) => ({ Id: p.Id, DocNumber: p.DocNumber, Vendor: p.VendorRef?.name, Total: p.TotalAmt, Date: p.TxnDate })) }), { headers: { ...cors, "Content-Type": "application/json" } });
      } else {
        return new Response(JSON.stringify({ error: `QB query failed: ${r.status}`, body: (await r.text()).substring(0, 500) }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
      }
    }

    return new Response(JSON.stringify({ success: true, results }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
