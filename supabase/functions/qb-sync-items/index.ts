import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version" };

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
      const query = `SELECT Id, Name, FullyQualifiedName, Type, Active, UnitPrice, PurchaseCost, Description FROM Item STARTPOSITION ${startPos} MAXRESULTS 1000`;
      const url = `https://quickbooks.api.intuit.com/v3/company/${realm_id}/query?query=${encodeURIComponent(query)}`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" } });
      if (!resp.ok) throw new Error(`QB query failed: ${resp.status} ${await resp.text()}`);
      const data = await resp.json();
      const items = data.QueryResponse?.Item || [];
      allItems.push(...items);
      if (items.length < 1000) break;
      startPos += 1000;
    }

    // Build lookup: Id -> QB item
    const qbItemsById: Record<string, any> = {};
    for (const item of allItems) qbItemsById[item.Id] = item;

    const changes: any[] = [];
    let baseUpdated = 0;
    let optionsUpdated = 0;
    let baseSkipped = 0;
    let optionsSkipped = 0;
    let missingInQB: string[] = [];

    // Sync base_models
    const { data: baseModels } = await supabase.from("base_models").select("id, name, qb_item_id, qb_item_name, cost_price, retail_price");
    for (const bm of (baseModels || [])) {
      if (!bm.qb_item_id) { missingInQB.push(`base: ${bm.name} (no QB ID)`); continue; }
      const qbItem = qbItemsById[bm.qb_item_id];
      if (!qbItem) { missingInQB.push(`base: ${bm.name} (QB ID ${bm.qb_item_id} not found)`); continue; }

      const updates: any = {};
      const diffs: string[] = [];

      // Check name match (use FullyQualifiedName)
      if (bm.qb_item_name !== qbItem.FullyQualifiedName && bm.qb_item_name !== qbItem.Name) {
        updates.qb_item_name = qbItem.FullyQualifiedName;
        diffs.push(`name: "${bm.qb_item_name}" -> "${qbItem.FullyQualifiedName}"`);
      }

      // Check retail price (QB UnitPrice = our retail)
      const qbRetail = qbItem.UnitPrice != null ? parseFloat(qbItem.UnitPrice) : null;
      if (qbRetail != null && Math.abs(qbRetail - parseFloat(bm.retail_price)) > 0.01) {
        updates.retail_price = qbRetail;
        diffs.push(`retail: $${bm.retail_price} -> $${qbRetail}`);
      }

      // Check cost price (QB PurchaseCost = our cost)
      const qbCost = qbItem.PurchaseCost != null ? parseFloat(qbItem.PurchaseCost) : null;
      if (qbCost != null && Math.abs(qbCost - parseFloat(bm.cost_price)) > 0.01) {
        updates.cost_price = qbCost;
        diffs.push(`cost: $${bm.cost_price} -> $${qbCost}`);
      }

      if (Object.keys(updates).length > 0) {
        await supabase.from("base_models").update(updates).eq("id", bm.id);
        changes.push({ item: bm.name, type: "base_model", diffs });
        baseUpdated++;
      } else {
        baseSkipped++;
      }
    }

    // Sync model_options
    const { data: options } = await supabase.from("model_options").select("id, name, qb_item_id, qb_item_name, cost_price, retail_price");
    for (const opt of (options || [])) {
      if (!opt.qb_item_id) { missingInQB.push(`option: ${opt.name} (no QB ID)`); continue; }
      const qbItem = qbItemsById[opt.qb_item_id];
      if (!qbItem) { missingInQB.push(`option: ${opt.name} (QB ID ${opt.qb_item_id} not found)`); continue; }

      const updates: any = {};
      const diffs: string[] = [];

      if (opt.qb_item_name !== qbItem.FullyQualifiedName && opt.qb_item_name !== qbItem.Name) {
        updates.qb_item_name = qbItem.FullyQualifiedName;
        diffs.push(`name: "${opt.qb_item_name}" -> "${qbItem.FullyQualifiedName}"`);
      }

      const qbRetail = qbItem.UnitPrice != null ? parseFloat(qbItem.UnitPrice) : null;
      if (qbRetail != null && Math.abs(qbRetail - parseFloat(opt.retail_price)) > 0.01) {
        updates.retail_price = qbRetail;
        diffs.push(`retail: $${opt.retail_price} -> $${qbRetail}`);
      }

      const qbCost = qbItem.PurchaseCost != null ? parseFloat(qbItem.PurchaseCost) : null;
      if (qbCost != null && Math.abs(qbCost - parseFloat(opt.cost_price)) > 0.01) {
        updates.cost_price = qbCost;
        diffs.push(`cost: $${opt.cost_price} -> $${qbCost}`);
      }

      if (Object.keys(updates).length > 0) {
        await supabase.from("model_options").update(updates).eq("id", opt.id);
        changes.push({ item: opt.name, type: "option", diffs });
        optionsUpdated++;
      } else {
        optionsSkipped++;
      }
    }

    return new Response(JSON.stringify({
      success: true,
      qb_items_fetched: allItems.length,
      base_models: { updated: baseUpdated, unchanged: baseSkipped, total: (baseModels || []).length },
      options: { updated: optionsUpdated, unchanged: optionsSkipped, total: (options || []).length },
      changes,
      missing_in_qb: missingInQB,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
