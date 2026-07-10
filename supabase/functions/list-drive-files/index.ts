// list-drive-files v1 — Lists all files in an order's Drive folder for manual browsing
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };

async function getGoogleToken(supabase: any): Promise<string> {
  const { data: t } = await supabase.from("google_tokens").select("*").limit(1).single();
  if (!t) throw new Error("Google not connected");
  if (new Date(t.access_token_expires_at) < new Date()) {
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: Deno.env.get("GOOGLE_CLIENT_ID") || "", client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") || "", refresh_token: t.refresh_token, grant_type: "refresh_token" }),
    });
    if (!resp.ok) throw new Error("Google token refresh failed");
    const tokens = await resp.json();
    await supabase.from("google_tokens").update({ access_token: tokens.access_token, access_token_expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString() }).eq("id", t.id);
    return tokens.access_token;
  }
  return t.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { order_id, folder_id } = await req.json();

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    let targetFolderId = folder_id;

    // If order_id provided, look up the folder
    if (order_id && !targetFolderId) {
      const { data: order } = await supabase.from("orders")
        .select("google_drive_folder_id, google_drive_folder_url")
        .eq("id", order_id).single();
      if (!order) return new Response(JSON.stringify({ success: false, error: "Order not found" }), { status: 200, headers: corsHeaders });
      targetFolderId = order.google_drive_folder_id;
      // Try to extract folder ID from URL if not stored directly
      if (!targetFolderId && order.google_drive_folder_url) {
        const match = order.google_drive_folder_url.match(/folders\/([a-zA-Z0-9_-]+)/);
        if (match) targetFolderId = match[1];
      }
    }

    if (!targetFolderId) return new Response(JSON.stringify({ success: false, error: "No Drive folder linked to this order" }), { status: 200, headers: corsHeaders });

    const googleToken = await getGoogleToken(supabase);

    // List root files
    const listUrl = `https://www.googleapis.com/drive/v3/files?q='${targetFolderId}'+in+parents+and+trashed=false&fields=files(id,name,mimeType,webViewLink,size,createdTime,modifiedTime)&orderBy=modifiedTime+desc&pageSize=100`;
    const listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${googleToken}` } });
    if (!listResp.ok) {
      const errText = await listResp.text();
      return new Response(JSON.stringify({ success: false, error: `Drive API ${listResp.status}: ${errText.substring(0, 200)}` }), { status: 200, headers: corsHeaders });
    }
    const allRaw = (await listResp.json()).files || [];

    // Also list files in subfolders
    const subFolders = allRaw.filter((f: any) => f.mimeType === "application/vnd.google-apps.folder");
    const rootFiles = allRaw.filter((f: any) => f.mimeType !== "application/vnd.google-apps.folder");

    const subFiles: any[] = [];
    for (const sub of subFolders) {
      const subUrl = `https://www.googleapis.com/drive/v3/files?q='${sub.id}'+in+parents+and+trashed=false&fields=files(id,name,mimeType,webViewLink,size,createdTime,modifiedTime)&orderBy=modifiedTime+desc&pageSize=50`;
      const subResp = await fetch(subUrl, { headers: { Authorization: `Bearer ${googleToken}` } });
      if (subResp.ok) {
        const sf = (await subResp.json()).files || [];
        for (const f of sf) {
          f._subfolder = sub.name;
          subFiles.push(f);
        }
      }
    }

    const files = [...rootFiles, ...subFiles].map((f: any) => ({
      id: f.id,
      name: f.name,
      url: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`,
      size: f.size || "0",
      mime_type: f.mimeType || "",
      modified: f.modifiedTime || f.createdTime || "",
      subfolder: f._subfolder || null,
    }));

    const folders = subFolders.map((f: any) => ({
      id: f.id,
      name: f.name,
    }));

    return new Response(JSON.stringify({
      success: true,
      files,
      folders,
      total: files.length,
    }), { status: 200, headers: corsHeaders });
  } catch (err: any) {
    console.error("list-drive-files error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 200, headers: corsHeaders });
  }
});
