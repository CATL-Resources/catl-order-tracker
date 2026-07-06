import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") || "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  try {
    if (action === "auth_url") {
      const redirectUri = `${SUPABASE_URL}/functions/v1/google-oauth-callback?action=callback`;
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", SCOPES);
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "consent");

      return new Response(JSON.stringify({ authUrl: authUrl.toString(), redirectUri }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "callback") {
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) return new Response(`<html><body><h2>Authorization failed</h2><p>${error}</p></body></html>`, { headers: { "Content-Type": "text/html" } });
      if (!code) return new Response(`<html><body><h2>No authorization code received</h2></body></html>`, { headers: { "Content-Type": "text/html" } });

      const redirectUri = `${SUPABASE_URL}/functions/v1/google-oauth-callback?action=callback`;

      const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: "authorization_code" }),
      });
      const tokenData = await tokenResp.json();

      if (!tokenData.access_token) {
        return new Response(`<html><body><h2>Token exchange failed</h2><pre>${JSON.stringify(tokenData, null, 2)}</pre></body></html>`, { headers: { "Content-Type": "text/html" } });
      }

      const userResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
      const userInfo = await userResp.json();
      const expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString();

      await supabase.from("google_tokens").delete().neq("id", "00000000-0000-0000-0000-000000000000");
      await supabase.from("google_tokens").insert({
        account_email: userInfo.email || "unknown",
        account_name: userInfo.name || "",
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        access_token_expires_at: expiresAt,
        scopes: SCOPES.split(" "),
      });

      return new Response(
        `<html><body style="font-family:Arial,sans-serif;max-width:500px;margin:80px auto;text-align:center;"><h2 style="color:#0E2646;">Google Account Connected</h2><p style="color:#55BAAA;font-size:18px;">&#10004; ${userInfo.email}</p><p style="color:#717182;">Gmail (read) and Google Drive (full) access authorized.</p><p style="color:#717182;">You can close this window.</p></body></html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    if (action === "status") {
      const { data: token } = await supabase.from("google_tokens").select("account_email, account_name, access_token_expires_at, scopes, updated_at").limit(1).single();
      if (!token) return new Response(JSON.stringify({ connected: false }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ connected: true, email: token.account_email, name: token.account_name, scopes: token.scopes, tokenExpiresAt: token.access_token_expires_at, lastUpdated: token.updated_at }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "Use ?action=auth_url, ?action=callback, or ?action=status" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err: any) {
    console.error("OAuth error:", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
