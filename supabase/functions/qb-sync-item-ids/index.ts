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
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const tokenData = await getQBToken(supabase);
    const { access_token, realm_id } = tokenData;

    // Fetch ALL items from QB (paginated)
    const allItems: any[] = [];
    let startPos = 1;
    while (true) {
      const query = `SELECT Id, Name, FullyQualifiedName, Type, Active FROM Item STARTPOSITION ${startPos} MAXRESULTS 1000`;
      const url = `https://quickbooks.api.intuit.com/v3/company/${realm_id}/query?query=${encodeURIComponent(query)}`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" } });
      if (!resp.ok) throw new Error(`QB query failed: ${resp.status} ${await resp.text()}`);
      const data = await resp.json();
      const items = data.QueryResponse?.Item || [];
      allItems.push(...items);
      if (items.length < 1000) break;
      startPos += 1000;
    }

    // Build lookup map: FullyQualifiedName -> Id
    const nameToId: Record<string, string> = {};
    for (const item of allItems) {
      nameToId[item.FullyQualifiedName] = item.Id;
      nameToId[item.Name] = item.Id; // also index by short name
    }

    // Match base_models
    const { data: baseModels } = await supabase.from("base_models").select("id, qb_item_name").not("qb_item_name", "is", null);
    let baseMatched = 0;
    for (const bm of (baseModels || [])) {
      const qbId = nameToId[bm.qb_item_name];
      if (qbId) {
        await supabase.from("base_models").update({ qb_item_id: qbId }).eq("id", bm.id);
        baseMatched++;
      }
    }

    // Match model_options
    const { data: options } = await supabase.from("model_options").select("id, qb_item_name").not("qb_item_name", "is", null);
    let optMatched = 0;
    for (const opt of (options || [])) {
      const qbId = nameToId[opt.qb_item_name];
      if (qbId) {
        await supabase.from("model_options").update({ qb_item_id: qbId }).eq("id", opt.id);
        optMatched++;
      }
    }

    // Find unmatched
    const unmatchedBase = (baseModels || []).filter(bm => !nameToId[bm.qb_item_name]).map(bm => bm.qb_item_name);
    const unmatchedOpts = (options || []).filter(o => !nameToId[o.qb_item_name]).map(o => o.qb_item_name);

    return new Response(JSON.stringify({
      success: true,
      qb_items_fetched: allItems.length,
      base_models_matched: baseMatched,
      base_models_total: (baseModels || []).length,
      options_matched: optMatched,
      options_total: (options || []).length,
      unmatched_base: unmatchedBase,
      unmatched_options: unmatchedOpts,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
