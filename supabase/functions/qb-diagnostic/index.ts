import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };

async function getQBToken(supabase: any) {
  const { data: tokenRow } = await supabase.from("qb_tokens").select("*").limit(1).single();
  if (!tokenRow) throw new Error("QuickBooks not connected");
  if (new Date(tokenRow.access_token_expires_at) > new Date()) return tokenRow;
  const clientId = Deno.env.get("QB_CLIENT_ID"); const clientSecret = Deno.env.get("QB_CLIENT_SECRET");
  const resp = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}` }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokenRow.refresh_token }) });
  if (!resp.ok) throw new Error(`Token refresh failed: ${await resp.text()}`);
  const tokens = await resp.json(); const now = new Date();
  await supabase.from("qb_tokens").update({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, access_token_expires_at: new Date(now.getTime() + tokens.expires_in * 1000).toISOString(), refresh_token_expires_at: new Date(now.getTime() + (tokens.x_refresh_token_expires_in || 8726400) * 1000).toISOString(), updated_at: now.toISOString() }).eq("id", tokenRow.id);
  return { ...tokenRow, access_token: tokens.access_token };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const tokenData = await getQBToken(supabase);
    const { access_token, realm_id } = tokenData;
    const baseUrl = Deno.env.get("QB_BASE_URL") || "https://quickbooks.api.intuit.com";
    const results: any = {};

    // Test 1: Look up a specific PO by ID
    if (body.qb_po_id) {
      const resp = await fetch(`${baseUrl}/v3/company/${realm_id}/purchaseorder/${body.qb_po_id}?minorversion=75`, {
        headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" }
      });
      results.id_lookup = { status: resp.status, body: resp.ok ? await resp.json() : await resp.text() };
    }

    // Test 2: Query POs by doc number
    if (body.doc_number) {
      const query = `SELECT * FROM PurchaseOrder WHERE DocNumber = '${body.doc_number}' MAXRESULTS 5`;
      const resp = await fetch(`${baseUrl}/v3/company/${realm_id}/query?query=${encodeURIComponent(query)}&minorversion=75`, {
        headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" }
      });
      results.doc_number_lookup = { status: resp.status, body: resp.ok ? await resp.json() : await resp.text() };
    }

    // Test 3: List recent POs
    if (body.list_recent) {
      const query = `SELECT Id, DocNumber, TxnDate, TotalAmt, VendorRef, PrivateNote FROM PurchaseOrder ORDERBY TxnDate DESC MAXRESULTS ${body.limit || 10}`;
      const resp = await fetch(`${baseUrl}/v3/company/${realm_id}/query?query=${encodeURIComponent(query)}&minorversion=75`, {
        headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" }
      });
      results.recent_pos = { status: resp.status, body: resp.ok ? await resp.json() : await resp.text() };
    }

    // Test 4: Search POs by vendor or note containing contract number
    if (body.search_note) {
      const query = `SELECT Id, DocNumber, TxnDate, TotalAmt, VendorRef, PrivateNote FROM PurchaseOrder WHERE PrivateNote LIKE '%${body.search_note}%' MAXRESULTS 10`;
      const resp = await fetch(`${baseUrl}/v3/company/${realm_id}/query?query=${encodeURIComponent(query)}&minorversion=75`, {
        headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" }
      });
      results.note_search = { status: resp.status, body: resp.ok ? await resp.json() : await resp.text() };
    }

    return new Response(JSON.stringify({ success: true, results }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
