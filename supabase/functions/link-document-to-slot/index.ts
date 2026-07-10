// link-document-to-slot v5 — Auto-creates slot if missing + text extraction
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };

const SLOT_LABELS: Record<string, string> = {
  catl_estimate: "CATL Estimate", approved_estimate: "Approved Estimate",
  catl_purchase_order: "CATL Purchase Order", mfg_web_order: "Mfg Web Order",
  mfg_sales_order: "Mfg Sales Order", signed_sales_order: "Signed Sales Order",
  mfg_invoice: "Mfg Invoice", qb_bill: "QB Bill",
  catl_customer_invoice: "Customer Invoice",
};

const EXTRACT_SLOTS = ["mfg_sales_order", "mfg_invoice", "signed_sales_order", "mfg_web_order"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const { order_id, slot_type, drive_file_id, drive_file_name, drive_file_url } = await req.json();
    if (!order_id || !slot_type || !drive_file_id) {
      return new Response(JSON.stringify({ success: false, error: "order_id, slot_type, and drive_file_id required" }), { status: 200, headers: corsHeaders });
    }

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: order } = await supabase.from("orders")
      .select("id, moly_contract_number, contract_name")
      .eq("id", order_id).single();
    if (!order) return new Response(JSON.stringify({ success: false, error: "Order not found" }), { status: 200, headers: corsHeaders });

    // Find existing slot or create one if missing
    let { data: slot } = await supabase.from("order_document_slots")
      .select("id, is_filled, document_id")
      .eq("order_id", order_id)
      .eq("slot_type", slot_type)
      .single();

    if (!slot) {
      // Auto-create the slot
      const { data: newSlot, error: createErr } = await supabase.from("order_document_slots")
        .insert({ order_id, slot_type })
        .select("id, is_filled, document_id")
        .single();
      if (createErr) return new Response(JSON.stringify({ success: false, error: `Failed to create slot: ${createErr.message}` }), { status: 200, headers: corsHeaders });
      slot = newSlot;
    }

    const fileUrl = drive_file_url || `https://drive.google.com/file/d/${drive_file_id}/view`;
    const fileName = drive_file_name || `Document-${drive_file_id}`;

    if (slot.document_id) {
      // Update existing document record
      const { error: updateErr } = await supabase.from("order_documents").update({
        file_url: fileUrl, file_name: fileName, file_type: "application/pdf",
        source: "drive", document_type: slot_type,
      }).eq("id", slot.document_id);
      if (updateErr) return new Response(JSON.stringify({ success: false, error: updateErr.message }), { status: 200, headers: corsHeaders });

      await supabase.from("order_document_slots").update({
        is_filled: true, filled_at: new Date().toISOString(),
        parsed_by: "manual_link", updated_at: new Date().toISOString(),
      }).eq("id", slot.id);
    } else {
      // Create new document record and link to slot
      const { data: docRecord, error: docErr } = await supabase.from("order_documents").insert({
        order_id, document_type: slot_type, title: fileName,
        description: `Manually linked: ${fileName}`,
        file_url: fileUrl, file_name: fileName,
        file_type: "application/pdf",
        source: "drive", manufacturer_ref: order.moly_contract_number || null,
        is_unmatched: false,
      }).select("id").single();
      if (docErr) return new Response(JSON.stringify({ success: false, error: docErr.message }), { status: 200, headers: corsHeaders });

      await supabase.from("order_document_slots").update({
        is_filled: true, filled_at: new Date().toISOString(),
        document_id: docRecord!.id,
        parsed_by: "manual_link", comparison_status: "pending",
        updated_at: new Date().toISOString(),
      }).eq("id", slot.id);
    }

    // Timeline entry
    try {
      await supabase.from("order_timeline").insert({
        order_id, event_type: "document_uploaded",
        title: `${SLOT_LABELS[slot_type] || slot_type} Linked`,
        description: `${fileName} manually linked from Drive`,
      });
    } catch (_) {}

    // Auto-trigger text extraction for manufacturer documents
    if (EXTRACT_SLOTS.includes(slot_type)) {
      try {
        const extractUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/extract-document-text`;
        fetch(extractUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
          body: JSON.stringify({ order_id, slot_type, force: false }),
        }).catch(() => {});
      } catch (_) {}
    }

    return new Response(JSON.stringify({
      success: true,
      summary: `${SLOT_LABELS[slot_type] || slot_type} linked to ${fileName}`,
      auto_extracting: EXTRACT_SLOTS.includes(slot_type),
    }), { status: 200, headers: corsHeaders });
  } catch (err: any) {
    console.error("link-document-to-slot error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 200, headers: corsHeaders });
  }
});
