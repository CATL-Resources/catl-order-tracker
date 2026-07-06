// qb-find-estimates v4 — Bill/PO search works for ALL orders (not just those with customers)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };

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

async function queryQB(baseUrl: string, realmId: string, accessToken: string, query: string): Promise<any[]> {
  const resp = await fetch(`${baseUrl}/v3/company/${realmId}/query?query=${encodeURIComponent(query)}&minorversion=75`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }
  });
  if (!resp.ok) { console.error(`QB query failed: ${resp.status} for: ${query}`); return []; }
  const data = await resp.json();
  const qr = data?.QueryResponse;
  if (!qr) return [];
  for (const v of Object.values(qr)) { if (Array.isArray(v)) return v; }
  return [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const body = await req.json();
    const targetOrderId = body.order_id || null;

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const tokenData = await getQBToken(supabase);
    const { access_token, realm_id } = tokenData;
    const baseUrl = Deno.env.get("QB_BASE_URL") || "https://quickbooks.api.intuit.com";

    // Get ALL orders (not just those with customers)
    let query = supabase.from("orders")
      .select("id, moly_contract_number, contract_name, qb_estimate_id, qb_po_id, qb_bill_id, qb_invoice_id, customer_price, cost_price, customer_id, customers(name, qb_customer_id)");
    if (targetOrderId) query = query.eq("id", targetOrderId);

    const { data: orders, error: ordErr } = await query;
    if (ordErr) throw ordErr;
    if (!orders || orders.length === 0) {
      return new Response(JSON.stringify({ success: true, summary: "No orders found", results: [] }), { headers: cors });
    }

    const results: any[] = [];
    let linked = { estimates: 0, invoices: 0, pos: 0, bills: 0 };

    for (const order of orders) {
      const contractNum = order.moly_contract_number || "";
      const cust = order.customers as any;
      const qbCustId = cust?.qb_customer_id;
      const orderResult: any = { order_id: order.id, contract: contractNum, estimate: null, invoice: null, po: null, bill: null };

      // Estimate — by customer
      if (!order.qb_estimate_id && qbCustId) {
        try {
          const estimates = await queryQB(baseUrl, realm_id, access_token, `SELECT * FROM Estimate WHERE CustomerRef = '${qbCustId}' ORDERBY MetaData.CreateTime DESC MAXRESULTS 20`);
          const match = findBestMatch(order, estimates);
          if (match) {
            const { error } = await supabase.from("orders").update({ qb_estimate_id: match.Id }).eq("id", order.id);
            if (!error) { linked.estimates++; orderResult.estimate = { qb_id: match.Id, doc_number: match.DocNumber }; }
          }
        } catch (e: any) { console.error(`Estimate search failed:`, e.message); }
      }

      // Invoice — by customer
      if (!order.qb_invoice_id && qbCustId) {
        try {
          const invoices = await queryQB(baseUrl, realm_id, access_token, `SELECT * FROM Invoice WHERE CustomerRef = '${qbCustId}' ORDERBY MetaData.CreateTime DESC MAXRESULTS 20`);
          const match = findBestMatch(order, invoices);
          if (match) {
            const { error } = await supabase.from("orders").update({ qb_invoice_id: match.Id }).eq("id", order.id);
            if (!error) { linked.invoices++; orderResult.invoice = { qb_id: match.Id, doc_number: match.DocNumber }; }
          }
        } catch (e: any) { console.error(`Invoice search failed:`, e.message); }
      }

      // PO — by DocNumber (contract number). Works for ALL orders.
      if (!order.qb_po_id && contractNum) {
        try {
          const pos = await queryQB(baseUrl, realm_id, access_token, `SELECT * FROM PurchaseOrder WHERE DocNumber = '${contractNum}' MAXRESULTS 5`);
          if (pos.length > 0) {
            const po = pos[0];
            const { error } = await supabase.from("orders").update({ qb_po_id: po.Id, qb_po_doc_number: po.DocNumber }).eq("id", order.id);
            if (!error) { linked.pos++; orderResult.po = { qb_id: po.Id, doc_number: po.DocNumber, total: po.TotalAmt }; }
          }
        } catch (e: any) { console.error(`PO search failed for ${contractNum}:`, e.message); }
      }

      // Bill — by DocNumber (contract number). Works for ALL orders.
      if (!order.qb_bill_id && contractNum) {
        try {
          const bills = await queryQB(baseUrl, realm_id, access_token, `SELECT * FROM Bill WHERE DocNumber = '${contractNum}' MAXRESULTS 5`);
          if (bills.length > 0) {
            const bill = bills[0];
            const { error } = await supabase.from("orders").update({ qb_bill_id: bill.Id }).eq("id", order.id);
            if (!error) { linked.bills++; orderResult.bill = { qb_id: bill.Id, doc_number: bill.DocNumber, total: bill.TotalAmt }; }
          }
        } catch (e: any) { console.error(`Bill search failed for ${contractNum}:`, e.message); }
      }

      if (orderResult.estimate || orderResult.invoice || orderResult.po || orderResult.bill) {
        results.push(orderResult);
      }
    }

    const summary = `Linked: ${linked.estimates} est, ${linked.invoices} inv, ${linked.pos} PO, ${linked.bills} bill across ${orders.length} orders`;
    return new Response(JSON.stringify({ success: true, summary, linked, orders_processed: orders.length, results }), { headers: cors });
  } catch (err: any) {
    console.error("qb-find-estimates error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), { headers: cors });
  }
});

function findBestMatch(order: any, qbDocs: any[]): any | null {
  const orderTotal = Number(order.customer_price || 0);
  const contractNum = order.moly_contract_number || "";
  let bestMatch: any = null;
  let bestScore = 0;

  for (const doc of qbDocs) {
    let score = 0;
    let reasons: string[] = [];
    if (contractNum && doc.DocNumber === contractNum) { score += 60; reasons.push("DocNumber exact"); }
    else if (contractNum && doc.DocNumber && doc.DocNumber.includes(contractNum)) { score += 50; reasons.push("DocNumber contains"); }
    const searchable = `${doc.PrivateNote || ""} ${doc.CustomerMemo?.value || ""} ${doc.Memo || ""}`.toLowerCase();
    if (contractNum && searchable.includes(contractNum.toLowerCase())) { score += 40; reasons.push("Memo match"); }
    if (orderTotal > 0 && doc.TotalAmt) {
      const pctDiff = Math.abs(Number(doc.TotalAmt) - orderTotal) / orderTotal;
      if (pctDiff < 0.01) { score += 30; reasons.push("Total exact"); }
      else if (pctDiff < 0.05) { score += 20; reasons.push("Total ~5%"); }
    }
    if (qbDocs.length === 1) { score += 20; reasons.push("Only one"); }
    if (score > bestScore) { bestScore = score; bestMatch = { ...doc, _match_reason: reasons.join(", ") }; }
  }
  return bestScore >= 20 ? bestMatch : null;
}
