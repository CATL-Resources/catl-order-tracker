import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Get QB token
    const { data: tokenRow } = await supabase.from("qb_tokens").select("*").limit(1).single();
    if (!tokenRow) throw new Error("No QB tokens");

    let access_token = tokenRow.access_token;
    const realm_id = tokenRow.realm_id;

    // Refresh if expired
    if (new Date(tokenRow.access_token_expires_at) <= new Date()) {
      const clientId = Deno.env.get("QB_CLIENT_ID");
      const clientSecret = Deno.env.get("QB_CLIENT_SECRET");
      const resp = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}` },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokenRow.refresh_token }),
      });
      if (!resp.ok) throw new Error(`Token refresh failed: ${await resp.text()}`);
      const tokens = await resp.json();
      access_token = tokens.access_token;
      const now = new Date();
      await supabase.from("qb_tokens").update({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        access_token_expires_at: new Date(now.getTime() + tokens.expires_in * 1000).toISOString(),
        refresh_token_expires_at: new Date(now.getTime() + (tokens.x_refresh_token_expires_in || 8726400) * 1000).toISOString(),
        updated_at: now.toISOString(),
      }).eq("id", tokenRow.id);
    }

    const baseUrl = "https://quickbooks.api.intuit.com";

    // Query all items (products/services)
    const query = "SELECT Id, Name, FullyQualifiedName, Type, Active FROM Item MAXRESULTS 1000";
    const resp = await fetch(
      `${baseUrl}/v3/company/${realm_id}/query?query=${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${access_token}`, Accept: "application/json" } }
    );
    if (!resp.ok) throw new Error(`QB query failed: ${resp.status} ${await resp.text()}`);

    const data = await resp.json();
    const items = data.QueryResponse?.Item || [];

    // Return simplified list
    const simplified = items.map((i: any) => ({
      id: i.Id,
      name: i.Name,
      full_name: i.FullyQualifiedName,
      type: i.Type,
      active: i.Active,
    }));

    return new Response(JSON.stringify({ success: true, count: simplified.length, items: simplified }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
