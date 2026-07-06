// extract-document-text v2 — FIX: chunked base64 encoding for large PDFs
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encode as base64Encode } from "https://deno.land/std@0.208.0/encoding/base64.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };

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

function extractDriveFileId(url: string): string | null {
  const m = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const { order_id, slot_type, force } = await req.json();
    if (!order_id) return new Response(JSON.stringify({ success: false, error: "order_id required" }), { headers: cors });
    const targetSlot = slot_type || "mfg_sales_order";

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: slot } = await supabase.from("order_document_slots")
      .select("id, document_id, is_filled, raw_extracted_text, line_items")
      .eq("order_id", order_id).eq("slot_type", targetSlot).single();
    if (!slot) return new Response(JSON.stringify({ success: false, error: `No ${targetSlot} slot found` }), { headers: cors });
    if (!slot.document_id) return new Response(JSON.stringify({ success: false, error: `${targetSlot} slot has no document linked` }), { headers: cors });

    if (!force && slot.raw_extracted_text && slot.line_items && (slot.line_items as any[]).length > 0) {
      return new Response(JSON.stringify({ success: true, already_extracted: true, summary: `Already has ${(slot.line_items as any[]).length} line items`, line_count: (slot.line_items as any[]).length }), { headers: cors });
    }

    const { data: doc } = await supabase.from("order_documents").select("file_url, file_name").eq("id", slot.document_id).single();
    if (!doc?.file_url) return new Response(JSON.stringify({ success: false, error: "Document has no file_url" }), { headers: cors });

    const driveFileId = extractDriveFileId(doc.file_url);
    if (!driveFileId) return new Response(JSON.stringify({ success: false, error: `Cannot parse Drive file ID from: ${doc.file_url}` }), { headers: cors });

    // Download PDF from Drive
    const googleToken = await getGoogleToken(supabase);
    const pdfResp = await fetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`, { headers: { Authorization: `Bearer ${googleToken}` } });
    if (!pdfResp.ok) {
      const errText = await pdfResp.text();
      return new Response(JSON.stringify({ success: false, error: `Drive download failed (${pdfResp.status}): ${errText.substring(0, 200)}` }), { headers: cors });
    }
    const pdfBytes = await pdfResp.arrayBuffer();

    // v2 FIX: Use Deno std library for base64 encoding (no stack overflow on large PDFs)
    const pdfBase64 = base64Encode(new Uint8Array(pdfBytes));

    console.log(`Downloaded PDF: ${doc.file_name} (${pdfBytes.byteLength} bytes)`);

    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!anthropicKey) return new Response(JSON.stringify({ success: false, error: "ANTHROPIC_API_KEY not set" }), { headers: cors });

    const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
            { type: "text", text: `Extract ALL text from this PDF document. This is a Moly Manufacturing sales order or invoice for livestock equipment (squeeze chutes and accessories).

I need:
1. The complete raw text of the document, preserving the layout as much as possible
2. A structured extraction of every line item with: item description, list price, discount percentage, and net/extended price

Respond in this exact JSON format (no markdown, no backticks, just raw JSON):
{
  "raw_text": "the full text of the document",
  "contract_number": "the Moly contract/order number if visible",
  "order_date": "date if visible",
  "items": [
    { "name": "item description", "list_price": 1234.56, "discount_pct": 20, "net_price": 987.65, "quantity": 1 }
  ],
  "subtotal": 12345.67,
  "tax": 0,
  "freight": 0,
  "surcharge": 0,
  "total": 12345.67,
  "deposit": 0,
  "balance_due": 12345.67
}

For items where the discount or list price isn't shown, set those to null. For deposits/payments, include them as items with negative net_price. Include ALL line items — equipment, options, accessories, deposits, surcharges, etc.` }
          ]
        }],
      }),
    });

    if (!claudeResp.ok) {
      const errBody = await claudeResp.text();
      return new Response(JSON.stringify({ success: false, error: `Claude API error (${claudeResp.status}): ${errBody.substring(0, 300)}` }), { headers: cors });
    }

    const claudeData = await claudeResp.json();
    const claudeText = claudeData.content?.map((c: any) => c.text || "").join("") || "";

    let parsed: any;
    try {
      const cleaned = claudeText.replace(/```json\s*|```\s*/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      console.error("Failed to parse Claude JSON, falling back to text parser:", claudeText.substring(0, 300));
      parsed = { raw_text: claudeText, items: [] };
    }

    const rawText = parsed.raw_text || claudeText;
    const items = parsed.items || [];
    const docTotal = parsed.total || parsed.balance_due || parsed.subtotal || null;

    const lineItems = items.map((item: any) => ({
      name: item.name || "Unknown",
      display_name: item.name || "Unknown",
      net_price: item.net_price != null ? Number(item.net_price) : null,
      list_price: item.list_price != null ? Number(item.list_price) : null,
      discount_pct: item.discount_pct != null ? Number(item.discount_pct) : null,
      unit_price: item.net_price != null ? Number(item.net_price) : null,
      cost_price_each: item.net_price != null ? Number(item.net_price) : null,
      quantity: item.quantity || 1,
      source: "pdf_extraction",
    }));

    const { error: updateErr } = await supabase.from("order_document_slots").update({
      raw_extracted_text: rawText,
      line_items: lineItems,
      total_amount: docTotal ? Number(docTotal) : null,
      subtotal: parsed.subtotal ? Number(parsed.subtotal) : null,
      parsed_by: "claude_pdf",
      parse_confidence: 0.9,
      updated_at: new Date().toISOString(),
    }).eq("id", slot.id);

    if (updateErr) {
      console.error("Slot update error:", updateErr);
      return new Response(JSON.stringify({ success: false, error: `Failed to save: ${updateErr.message}` }), { headers: cors });
    }

    return new Response(JSON.stringify({
      success: true,
      summary: `Extracted ${lineItems.length} line items from ${doc.file_name}`,
      line_count: lineItems.length, total: docTotal,
      contract_number: parsed.contract_number || null, items: lineItems,
    }), { headers: cors });
  } catch (err: any) {
    console.error("extract-document-text error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), { headers: cors });
  }
});
