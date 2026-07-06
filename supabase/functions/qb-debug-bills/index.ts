// qb-debug-bills v1 — Dump all Moly bills to see actual DocNumber format
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const vendorId = body.vendor_id || "2003"; // Moly default
    const searchDoc = body.doc_number || null;

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const tokenData = await getQBToken(supabase);
    const { access_token, realm_id } = tokenData;
    const baseUrl = Deno.env.get("QB_BASE_URL") || "https://quickbooks.api.intuit.com";

    const results: any = { bills: [], pos: [], queries_run: [] };

    // Query 1: All bills for this vendor
    const billQuery = `SELECT Id, DocNumber, TxnDate, TotalAmt, PrivateNote, DueDate FROM Bill WHERE VendorRef = '${vendorId}' ORDERBY MetaData.CreateTime DESC MAXRESULTS 100`;
    results.queries_run.push(billQuery);
    const billResp = await fetch(`${baseUrl}/v3/company/${realm_id}/query?query=${encodeURIComponent(billQuery)}&minorversion=75`, {
      headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" }
    });
    if (billResp.ok) {
      const billData = await billResp.json();
      const qr = billData?.QueryResponse;
      if (qr?.Bill) results.bills = qr.Bill.map((b: any) => ({ id: b.Id, doc_number: b.DocNumber, date: b.TxnDate, total: b.TotalAmt, note: b.PrivateNote?.substring(0, 100) }));
      results.bill_count = qr?.totalCount || results.bills.length;
    } else {
      results.bill_error = `${billResp.status}: ${await billResp.text()}`;
    }

    // Query 2: If searching for a specific doc number
    if (searchDoc) {
      const searchQuery = `SELECT Id, DocNumber, TxnDate, TotalAmt FROM Bill WHERE DocNumber = '${searchDoc}' MAXRESULTS 5`;
      results.queries_run.push(searchQuery);
      const searchResp = await fetch(`${baseUrl}/v3/company/${realm_id}/query?query=${encodeURIComponent(searchQuery)}&minorversion=75`, {
        headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" }
      });
      if (searchResp.ok) {
        const searchData = await searchResp.json();
        results.search_result = searchData?.QueryResponse;
      } else {
        results.search_error = `${searchResp.status}: ${await searchResp.text()}`;
      }

      // Also try without vendor filter
      const globalQuery = `SELECT Id, DocNumber, VendorRef, TxnDate, TotalAmt FROM Bill WHERE DocNumber = '${searchDoc}' MAXRESULTS 5`;
      results.queries_run.push(globalQuery);
      const globalResp = await fetch(`${baseUrl}/v3/company/${realm_id}/query?query=${encodeURIComponent(globalQuery)}&minorversion=75`, {
        headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" }
      });
      if (globalResp.ok) {
        results.global_search = await globalResp.json();
      }
    }

    // Query 3: All POs for this vendor (for comparison)
    const poQuery = `SELECT Id, DocNumber, TxnDate, TotalAmt FROM PurchaseOrder WHERE VendorRef = '${vendorId}' ORDERBY MetaData.CreateTime DESC MAXRESULTS 50`;
    results.queries_run.push(poQuery);
    const poResp = await fetch(`${baseUrl}/v3/company/${realm_id}/query?query=${encodeURIComponent(poQuery)}&minorversion=75`, {
      headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" }
    });
    if (poResp.ok) {
      const poData = await poResp.json();
      const qr = poData?.QueryResponse;
      if (qr?.PurchaseOrder) results.pos = qr.PurchaseOrder.map((p: any) => ({ id: p.Id, doc_number: p.DocNumber, date: p.TxnDate, total: p.TotalAmt }));
      results.po_count = qr?.totalCount || results.pos.length;
    }

    return new Response(JSON.stringify({ success: true, ...results }), { headers: cors });
  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { headers: cors });
  }
});
