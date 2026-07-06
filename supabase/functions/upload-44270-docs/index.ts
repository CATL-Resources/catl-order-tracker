import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") || "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };

async function getGoogleAccessToken(): Promise<string> {
  const { data: tokenRow, error } = await supabase.from("google_tokens").select("*").limit(1).single();
  if (error || !tokenRow) throw new Error("No Google token found.");
  const now = new Date();
  const expiresAt = new Date(tokenRow.access_token_expires_at);
  if (now < expiresAt) return tokenRow.access_token;
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: tokenRow.refresh_token, grant_type: "refresh_token" }),
  });
  const tokenData = await resp.json();
  if (!tokenData.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(tokenData)}`);
  const newExpiry = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString();
  await supabase.from("google_tokens").update({ access_token: tokenData.access_token, access_token_expires_at: newExpiry, updated_at: new Date().toISOString() }).eq("id", tokenRow.id);
  return tokenData.access_token;
}

async function gmailGetMessage(accessToken: string, messageId: string): Promise<any> {
  const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, { headers: { Authorization: `Bearer ${accessToken}` } });
  return await resp.json();
}

async function gmailGetAttachment(accessToken: string, messageId: string, attachmentId: string): Promise<Uint8Array> {
  const resp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await resp.json();
  const base64 = data.data.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function uploadToDrive(accessToken: string, fileName: string, fileBytes: Uint8Array, folderId: string): Promise<{ id: string; webViewLink: string }> {
  const metadata = { name: fileName, parents: [folderId], mimeType: "application/pdf" };
  const boundary = "----FormBoundary" + Date.now();
  const encoder = new TextEncoder();
  const parts = [
    encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    encoder.encode(`--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
    fileBytes,
    encoder.encode(`\r\n--${boundary}--`),
  ];
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.length; }
  const resp = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return await resp.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const accessToken = await getGoogleAccessToken();

    // Drive folder for 44270 (SILENCER 2026)
    const driveFolderId = "1j4M2BqjsfBMjI-pRblW6wEQDERJyvavR"; // from orders.google_drive_folder_id
    const orderId = "2183ca4a-5aea-47e3-941a-e0ae0caf8fb9";

    // The 3 target attachments we know exist:
    const targets = [
      {
        messageId: "19c49900a5f8daa8",
        // CATL0411021026.pdf is a text/plain with attachmentId — need to find it
        fileName: "CATL0411021026.pdf",
        docId: "29d1c52b-7ac0-4e5e-8cce-ee2d88cf958d",
        docTitle: "Moly Order Confirmation — CATL0411021026",
      },
      {
        messageId: "19c7c896043dc16d",
        fileName: "44270 CATL 2026-17 (revised).pdf",
        docId: "584363e1-18f3-4cdc-b749-b0c149ac1581",
        docTitle: "Moly Sales Order 44270 — Revised (unsigned)",
      },
      {
        messageId: "19cf826dc694ab08",
        fileName: "44270 CATL 2026-17 (revised) signed 3-16-26.pdf",
        docId: "c734d67d-3f4e-4de7-9b9b-e635c4112d10",
        docTitle: "Moly Sales Order 44270 — Signed 3-16-26",
      },
    ];

    const results = [];

    for (const target of targets) {
      try {
        const fullMsg = await gmailGetMessage(accessToken, target.messageId);

        // Collect all parts recursively
        const allParts: any[] = [];
        function collectParts(parts: any[]) {
          for (const p of parts) {
            allParts.push(p);
            if (p.parts) collectParts(p.parts);
          }
        }
        if (fullMsg.payload?.parts) collectParts(fullMsg.payload.parts);
        else allParts.push(fullMsg.payload);

        // Find the matching attachment by filename
        const matchPart = allParts.find((p: any) =>
          p.filename && p.filename.toLowerCase().includes(target.fileName.toLowerCase().replace(" (revised)", "").split(".")[0].toLowerCase().slice(0, 10))
          && p.body?.attachmentId
        ) || allParts.find((p: any) => p.body?.attachmentId); // fallback: first attachment

        if (!matchPart?.body?.attachmentId) {
          results.push({ file: target.fileName, status: "no_attachment_found", parts: allParts.map((p:any) => ({ fn: p.filename, mime: p.mimeType, hasId: !!p.body?.attachmentId })) });
          continue;
        }

        const fileBytes = await gmailGetAttachment(accessToken, target.messageId, matchPart.body.attachmentId);
        const driveResult = await uploadToDrive(accessToken, target.fileName, fileBytes, driveFolderId);

        if (!driveResult.id) {
          results.push({ file: target.fileName, status: "drive_upload_failed", driveResult });
          continue;
        }

        // Update the order_documents record with the Drive URL
        await supabase.from("order_documents")
          .update({ file_url: driveResult.webViewLink, updated_at: new Date().toISOString() })
          .eq("id", target.docId);

        results.push({ file: target.fileName, status: "uploaded", driveFileId: driveResult.id, driveUrl: driveResult.webViewLink });
      } catch (e: any) {
        results.push({ file: target.fileName, status: "error", error: e.message });
      }
    }

    return new Response(JSON.stringify({ success: true, results }, null, 2), { headers: corsHeaders });
  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 200, headers: corsHeaders });
  }
});
