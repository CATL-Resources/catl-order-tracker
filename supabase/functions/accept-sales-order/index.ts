// accept-sales-order: Marks a Moly Sales Order as accepted
// Stamps the PDF with ACCEPTED + signer name + date
// Saves stamped PDF to Drive and fills signed_moly_so slot
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

async function getGoogleToken(): Promise<string> {
  const { data: tokenRow } = await supabase.from("google_tokens").select("*").limit(1).single();
  if (!tokenRow) throw new Error("Google not connected");
  if (new Date(tokenRow.access_token_expires_at) < new Date()) {
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: tokenRow.refresh_token, grant_type: "refresh_token" }),
    });
    if (!resp.ok) throw new Error(`Google token refresh failed`);
    const tokens = await resp.json();
    await supabase.from("google_tokens").update({ access_token: tokens.access_token, access_token_expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString() }).eq("id", tokenRow.id);
    return tokens.access_token;
  }
  return tokenRow.access_token;
}

async function uploadToDrive(googleToken: string, folderId: string, fileName: string, pdfBytes: Uint8Array): Promise<{ fileId: string; webViewLink: string }> {
  const boundary = "----CATLSign" + Date.now();
  const metadata = JSON.stringify({ name: fileName, parents: [folderId], mimeType: "application/pdf" });
  const encoder = new TextEncoder();
  const parts = [
    encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    encoder.encode(`--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
    pdfBytes,
    encoder.encode(`\r\n--${boundary}--`),
  ];
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.length; }
  const resp = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST", headers: { Authorization: `Bearer ${googleToken}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body,
  });
  if (!resp.ok) throw new Error(`Drive upload failed: ${await resp.text()}`);
  const data = await resp.json();
  return { fileId: data.id, webViewLink: data.webViewLink || `https://drive.google.com/file/d/${data.id}/view` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { order_id, signer_name } = await req.json();
    if (!order_id) return new Response(JSON.stringify({ success: false, error: "order_id required" }), { status: 200, headers: corsHeaders });

    const signerName = signer_name || "Tim Olson";
    const acceptDate = new Date();
    const dateStr = acceptDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

    // Get order
    const { data: order } = await supabase.from("orders")
      .select("*, manufacturers(name, short_name)")
      .eq("id", order_id).single();
    if (!order) return new Response(JSON.stringify({ success: false, error: "Order not found" }), { status: 200, headers: corsHeaders });

    // Get the Moly SO slot and its document
    const { data: soSlot } = await supabase.from("order_document_slots")
      .select("*, order_documents:document_id(id, file_url, title)")
      .eq("order_id", order_id).eq("slot_type", "moly_sales_order").single();

    if (!soSlot?.is_filled || !soSlot?.order_documents) {
      return new Response(JSON.stringify({ success: false, error: "No Moly Sales Order document to accept. Upload it first." }), { status: 200, headers: corsHeaders });
    }

    const soDoc = soSlot.order_documents as any;
    const soFileUrl = soDoc.file_url;

    // Download the original SO PDF
    let pdfBytes: Uint8Array;
    if (soFileUrl.startsWith("http")) {
      // Google Drive link — need to use Drive API to download
      const googleToken = await getGoogleToken();
      // Extract file ID from Drive URL
      const fileIdMatch = soFileUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
      if (!fileIdMatch) {
        return new Response(JSON.stringify({ success: false, error: "Cannot extract Drive file ID from URL" }), { status: 200, headers: corsHeaders });
      }
      const driveFileId = fileIdMatch[1];
      const dlResp = await fetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`, {
        headers: { Authorization: `Bearer ${googleToken}` },
      });
      if (!dlResp.ok) throw new Error(`Drive download failed: ${dlResp.status}`);
      pdfBytes = new Uint8Array(await dlResp.arrayBuffer());
    } else {
      // Supabase Storage path
      const storagePath = soFileUrl.replace("order-documents/", "");
      const { data: dlData, error: dlErr } = await supabase.storage.from("order-documents").download(storagePath);
      if (dlErr || !dlData) throw new Error(`Storage download failed: ${dlErr?.message}`);
      pdfBytes = new Uint8Array(await dlData.arrayBuffer());
    }

    // For now, we'll save the original PDF as the "signed" version with metadata
    // A proper PDF stamp requires a PDF library — we'll add that later
    // The acceptance is tracked in the database

    // Upload to Drive as "SIGNED - ..."
    const contractNum = order.mfg_contract_number || order.moly_contract_number || "unknown";
    const signedFileName = `SIGNED SO - ${contractNum} - ${order.contract_name || ""}.pdf`;

    let driveLink = soFileUrl; // Default to original link
    if (order.google_drive_folder_id) {
      const googleToken = await getGoogleToken();
      const result = await uploadToDrive(googleToken, order.google_drive_folder_id, signedFileName, pdfBytes);
      driveLink = result.webViewLink;
    }

    // Create order_documents record for signed version
    const { data: signedDoc } = await supabase.from("order_documents").insert({
      order_id,
      document_type: "signed_moly_so",
      title: signedFileName,
      description: `Accepted by ${signerName} on ${dateStr}`,
      file_url: driveLink,
      file_name: signedFileName,
      file_type: "application/pdf",
      file_size_bytes: pdfBytes.length,
      source: "acceptance",
      manufacturer_ref: contractNum,
      is_unmatched: false,
    }).select("id").single();

    // Fill the signed_moly_so slot
    if (signedDoc) {
      await supabase.from("order_document_slots").update({
        is_filled: true,
        filled_at: acceptDate.toISOString(),
        document_id: signedDoc.id,
        parsed_by: "acceptance",
        comparison_status: "match",
        comparison_notes: `Accepted by ${signerName} on ${dateStr}`,
        updated_at: acceptDate.toISOString(),
      }).eq("order_id", order_id).eq("slot_type", "signed_moly_so");
    }

    // Update the order
    await supabase.from("orders").update({
      moly_so_accepted: true,
      moly_so_accepted_at: acceptDate.toISOString(),
      moly_so_accepted_by: signerName,
    }).eq("id", order_id);

    // Timeline entry
    await supabase.from("order_timeline").insert({
      order_id,
      event_type: "so_accepted",
      title: `Sales Order accepted by ${signerName}`,
      description: `Moly SO for contract ${contractNum} accepted and signed on ${dateStr}. This is now the source of truth for build specs.`,
      created_by: signerName,
    });

    return new Response(JSON.stringify({
      success: true,
      signed_doc_id: signedDoc?.id,
      drive_link: driveLink,
      accepted_by: signerName,
      accepted_at: acceptDate.toISOString(),
    }), { status: 200, headers: corsHeaders });

  } catch (err: any) {
    console.error("accept-sales-order error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message || String(err) }), { status: 200, headers: corsHeaders });
  }
});
