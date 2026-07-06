// gmail-download-attachment v3 — Uses mfg_sales_order/mfg_invoice (manufacturer-generic)
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

function detectSlotType(fileName: string, _contractNum: string | null): string | null {
  if (/_SO_.*IN_/i.test(fileName) || /_SO_\d+IN/i.test(fileName)) return "mfg_invoice";
  if (/^catl\d+\.pdf$/i.test(fileName)) return "mfg_sales_order";
  if (/purchase.*order|\bPO\b/i.test(fileName)) return "catl_purchase_order";
  if (/estimate|quote/i.test(fileName)) return "catl_estimate";
  if (/\bbill\b/i.test(fileName)) return "qb_bill";
  if (/customer.*invoice/i.test(fileName)) return "catl_customer_invoice";
  if (/invoice/i.test(fileName)) return "mfg_invoice";
  if (/sales.*order|\bSO\b/i.test(fileName)) return "mfg_sales_order";
  return null;
}

const SLOT_LABELS: Record<string, string> = {
  mfg_sales_order: "Mfg Sales Order", mfg_invoice: "Mfg Invoice",
  catl_estimate: "CATL Estimate", catl_purchase_order: "CATL Purchase Order",
  qb_bill: "Manufacturer Bill", catl_customer_invoice: "Customer Invoice",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { gmail_message_id, order_id, slot_type: forceSlotType, attachment_index } = await req.json();
    if (!gmail_message_id || !order_id) {
      return new Response(JSON.stringify({ success: false, error: "gmail_message_id and order_id required" }), { status: 200, headers: corsHeaders });
    }

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const googleToken = await getGoogleToken(supabase);

    const { data: order } = await supabase.from("orders")
      .select("id, google_drive_folder_id, moly_contract_number, contract_name")
      .eq("id", order_id).single();
    if (!order) return new Response(JSON.stringify({ success: false, error: "Order not found" }), { status: 200, headers: corsHeaders });
    if (!order.google_drive_folder_id) return new Response(JSON.stringify({ success: false, error: "No Drive folder linked to this order" }), { status: 200, headers: corsHeaders });

    const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmail_message_id}?format=full`;
    const msgResp = await fetch(msgUrl, { headers: { Authorization: `Bearer ${googleToken}` } });
    if (!msgResp.ok) return new Response(JSON.stringify({ success: false, error: `Gmail fetch failed: ${msgResp.status}` }), { status: 200, headers: corsHeaders });
    const msg = await msgResp.json();

    const attachments: { filename: string; attachmentId: string; mimeType: string; size: number }[] = [];
    function findAttachments(parts: any[]) {
      for (const part of (parts || [])) {
        if (part.filename && part.filename.length > 0 && part.body?.attachmentId) {
          attachments.push({ filename: part.filename, attachmentId: part.body.attachmentId, mimeType: part.mimeType || "application/pdf", size: part.body.size || 0 });
        }
        if (part.parts) findAttachments(part.parts);
      }
    }
    findAttachments(msg.payload?.parts || []);
    if (msg.payload?.filename && msg.payload?.body?.attachmentId) {
      attachments.push({ filename: msg.payload.filename, attachmentId: msg.payload.body.attachmentId, mimeType: msg.payload.mimeType || "application/pdf", size: msg.payload.body.size || 0 });
    }
    if (attachments.length === 0) return new Response(JSON.stringify({ success: false, error: "No attachments found" }), { status: 200, headers: corsHeaders });

    const results: any[] = [];
    const toProcess = attachment_index !== undefined ? [attachments[attachment_index] || attachments[0]] : attachments.filter(a => a.filename.toLowerCase().endsWith('.pdf'));

    for (const att of toProcess) {
      const fileName = att.filename;
      const slotType = forceSlotType || detectSlotType(fileName, order.moly_contract_number);

      const attUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${gmail_message_id}/attachments/${att.attachmentId}`;
      const attResp = await fetch(attUrl, { headers: { Authorization: `Bearer ${googleToken}` } });
      if (!attResp.ok) { results.push({ file: fileName, error: `Download failed: ${attResp.status}` }); continue; }
      const attData = await attResp.json();
      const base64Data = attData.data.replace(/-/g, '+').replace(/_/g, '/');

      const metadata = { name: fileName, parents: [order.google_drive_folder_id], mimeType: att.mimeType };
      const boundary = "----boundary" + Date.now();
      const multipartBody = [`--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata), `--${boundary}`, `Content-Type: ${att.mimeType}`, 'Content-Transfer-Encoding: base64', '', base64Data, `--${boundary}--`].join('\r\n');

      const uploadResp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
        method: 'POST', headers: { Authorization: `Bearer ${googleToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipartBody,
      });
      if (!uploadResp.ok) { results.push({ file: fileName, error: `Drive upload failed: ${uploadResp.status}` }); continue; }
      const driveFile = await uploadResp.json();
      const fileUrl = driveFile.webViewLink || `https://drive.google.com/file/d/${driveFile.id}/view`;

      const { data: docRecord, error: docErr } = await supabase.from("order_documents").insert({
        order_id, document_type: slotType || "mfg_invoice", title: fileName,
        description: `Downloaded from Gmail: ${fileName}`,
        file_url: fileUrl, file_name: fileName, file_type: att.mimeType,
        file_size_bytes: att.size, source: "email",
        manufacturer_ref: order.moly_contract_number || null, is_unmatched: !slotType,
      }).select("id").single();
      if (docErr) { results.push({ file: fileName, error: `Doc insert: ${docErr.message}`, drive_url: fileUrl }); continue; }

      let slotFilled = false;
      if (slotType && docRecord) {
        const { data: slot } = await supabase.from("order_document_slots")
          .select("id, is_filled, document_id").eq("order_id", order_id).eq("slot_type", slotType).single();
        if (slot && !slot.is_filled) {
          await supabase.from("order_document_slots").update({
            is_filled: true, filled_at: new Date().toISOString(), document_id: docRecord.id,
            parsed_by: "gmail_download", comparison_status: "pending", updated_at: new Date().toISOString(),
          }).eq("id", slot.id);
          slotFilled = true;
        } else if (slot?.is_filled && slot.document_id) {
          const { data: existingDoc } = await supabase.from("order_documents").select("file_url").eq("id", slot.document_id).single();
          if (!existingDoc?.file_url) {
            await supabase.from("order_documents").update({ file_url: fileUrl, file_name: fileName, file_type: att.mimeType, file_size_bytes: att.size, source: "email" }).eq("id", slot.document_id);
            slotFilled = true;
          }
        }
      }

      await supabase.from("gmail_inbox").update({ processed: true }).eq("gmail_message_id", gmail_message_id);
      await supabase.from("order_timeline").insert({
        order_id, event_type: "document_uploaded",
        title: `${SLOT_LABELS[slotType || ''] || 'Document'} Downloaded`,
        description: `${SLOT_LABELS[slotType || ''] || 'Document'} (${fileName}) downloaded from Gmail and saved to Drive`,
      }).catch(() => {});

      results.push({ file: fileName, success: true, drive_url: fileUrl, slot_type: slotType, slot_filled: slotFilled, document_id: docRecord?.id });
    }

    const successCount = results.filter(r => r.success).length;
    return new Response(JSON.stringify({ success: successCount > 0, summary: `Processed ${results.length} attachment(s), ${successCount} succeeded`, results }), { status: 200, headers: corsHeaders });
  } catch (err: any) {
    console.error("gmail-download-attachment error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 200, headers: corsHeaders });
  }
});
