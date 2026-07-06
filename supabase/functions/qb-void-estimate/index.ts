// qb-void-estimate: Voids an estimate in QuickBooks
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { estimate_id, action } = await req.json();
    // action: 'void_in_qb' | 'delete_local_only'
    if (!estimate_id) return new Response(JSON.stringify({ success: false, error: "estimate_id required" }), { status: 200, headers: corsHeaders });

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: estimate } = await supabase.from("estimates").select("*").eq("id", estimate_id).single();
    if (!estimate) return new Response(JSON.stringify({ success: false, error: "Estimate not found" }), { status: 200, headers: corsHeaders });

    const qbEstimateId = estimate.qb_estimate_id;
    const qbDocNumber = estimate.qb_doc_number;
    let voidedInQB = false;

    if (action === 'void_in_qb' && qbEstimateId) {
      // Void the estimate in QuickBooks
      // QB doesn't have a void endpoint for estimates — we delete it instead
      // First get the SyncToken
      const tokenData = await getQBToken(supabase);
      const { access_token, realm_id } = tokenData;
      const baseUrl = "https://quickbooks.api.intuit.com";

      // Get current SyncToken
      const getResp = await fetch(`${baseUrl}/v3/company/${realm_id}/estimate/${qbEstimateId}?minorversion=73`, {
        headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" }
      });

      if (getResp.ok) {
        const existing = await getResp.json();
        const syncToken = existing.Estimate.SyncToken;

        // Delete the estimate in QB
        const deleteResp = await fetch(`${baseUrl}/v3/company/${realm_id}/estimate?operation=delete&minorversion=73`, {
          method: "POST",
          headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ Id: qbEstimateId, SyncToken: syncToken }),
        });

        if (deleteResp.ok) {
          voidedInQB = true;
        } else {
          const errText = await deleteResp.text();
          console.error(`QB delete failed: ${deleteResp.status} ${errText}`);
          // Don't block local delete if QB delete fails
        }
      }
    }

    // Update the estimate record — mark as voided/deleted
    await supabase.from("estimates").update({
      qb_sync_status: voidedInQB ? 'voided' : 'deleted_locally',
    }).eq("id", estimate_id);

    // If there's an order linked, add timeline entry
    if (estimate.order_id) {
      await supabase.from("order_timeline").insert({
        order_id: estimate.order_id,
        event_type: "estimate_deleted",
        title: `Estimate ${qbDocNumber || estimate.estimate_number || ''} deleted`,
        description: voidedInQB
          ? `Deleted in both app and QuickBooks (QB ID: ${qbEstimateId})`
          : qbEstimateId
            ? `Deleted locally only. QB Estimate #${qbDocNumber} still exists in QuickBooks.`
            : `Deleted (was never pushed to QuickBooks)`,
        created_by: "system",
      });
    }

    // Now actually delete the estimate
    await supabase.from("estimates").delete().eq("id", estimate_id);

    return new Response(JSON.stringify({
      success: true,
      voided_in_qb: voidedInQB,
      qb_estimate_id: qbEstimateId,
      qb_doc_number: qbDocNumber,
    }), { status: 200, headers: corsHeaders });

  } catch (err: any) {
    console.error("qb-void-estimate error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message || String(err) }), { status: 200, headers: corsHeaders });
  }
});
