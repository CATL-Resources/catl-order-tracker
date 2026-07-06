import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: tokenRow } = await supabase.from("qb_tokens").select("*").limit(1).single();
  const baseUrl = Deno.env.get("QB_BASE_URL") || "https://quickbooks.api.intuit.com";
  const resp = await fetch(`${baseUrl}/v3/company/${tokenRow.realm_id}/query?query=${encodeURIComponent("SELECT * FROM Vendor WHERE DisplayName LIKE '%Moly%' OR DisplayName LIKE '%MOLY%'")}`, {
    headers: { Authorization: `Bearer ${tokenRow.access_token}`, Accept: "application/json" },
  });
  const data = await resp.json();
  const vendors = data?.QueryResponse?.Vendor || [];
  return new Response(JSON.stringify(vendors.map((v: any) => ({ id: v.Id, name: v.DisplayName, balance: v.Balance }))), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
