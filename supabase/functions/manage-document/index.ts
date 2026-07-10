import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { action, document_id, order_id } = await req.json();

    // ===== DELETE =====
    if (action === "delete") {
      if (!document_id) return new Response(JSON.stringify({ success: false, error: "document_id required" }), { status: 200, headers: corsHeaders });

      // Get the file path so we can delete from storage too
      const { data: doc } = await supabase.from("order_documents").select("file_url, file_name").eq("id", document_id).single();

      if (doc?.file_url) {
        // file_url format: "order-documents/folder/email_id/filename"
        // Storage path is everything after "order-documents/"
        const storagePath = doc.file_url.replace(/^order-documents\//, "");
        const { error: storageErr } = await supabase.storage.from("order-documents").remove([storagePath]);
        if (storageErr) console.error("Storage delete warning:", storageErr);
      }

      // Also clear any document slot that references this document
      await supabase.from("order_document_slots").update({
        is_filled: false, filled_at: null, document_id: null,
        line_items: [], base_model: null, chute_length: null, floor_type: null,
        subtotal: null, discount_amount: null, tax_amount: null, freight_amount: null, total_amount: null,
        raw_extracted_text: null, parsed_by: null, parse_confidence: null,
        comparison_status: null, comparison_notes: null, last_compared_at: null,
        updated_at: new Date().toISOString(),
      }).eq("document_id", document_id);

      // Delete the document record
      const { error: delErr } = await supabase.from("order_documents").delete().eq("id", document_id);
      if (delErr) return new Response(JSON.stringify({ success: false, error: delErr.message }), { status: 200, headers: corsHeaders });

      return new Response(JSON.stringify({ success: true, deleted: document_id }), { status: 200, headers: corsHeaders });
    }

    // ===== MANUAL MATCH =====
    if (action === "match") {
      if (!document_id || !order_id) return new Response(JSON.stringify({ success: false, error: "document_id and order_id required" }), { status: 200, headers: corsHeaders });

      // Get document details
      const { data: doc } = await supabase.from("order_documents").select("*").eq("id", document_id).single();
      if (!doc) return new Response(JSON.stringify({ success: false, error: "Document not found" }), { status: 200, headers: corsHeaders });

      // Get old storage path and new storage path
      const oldStoragePath = (doc.file_url || "").replace(/^order-documents\//, "");
      const filename = doc.file_name || "unknown";
      const emailId = oldStoragePath.split("/")[1] || "manual";
      const newStoragePath = `${order_id}/${emailId}/${filename}`;

      // Move file in storage (copy + delete old)
      if (oldStoragePath && oldStoragePath.startsWith("unmatched/")) {
        const { data: fileData } = await supabase.storage.from("order-documents").download(oldStoragePath);
        if (fileData) {
          const bytes = new Uint8Array(await fileData.arrayBuffer());
          await supabase.storage.from("order-documents").upload(newStoragePath, bytes, {
            contentType: doc.file_type || "application/octet-stream", upsert: true,
          });
          await supabase.storage.from("order-documents").remove([oldStoragePath]);
        }
      }

      // Update document record
      const { error: updateErr } = await supabase.from("order_documents").update({
        order_id: order_id,
        is_unmatched: false,
        file_url: `order-documents/${newStoragePath}`,
        match_attempted_at: new Date().toISOString(),
      }).eq("id", document_id);

      if (updateErr) return new Response(JSON.stringify({ success: false, error: updateErr.message }), { status: 200, headers: corsHeaders });

      // Add timeline entry
      await supabase.from("order_timeline").insert({
        order_id: order_id,
        event_type: "document_received",
        title: "Document manually matched to order",
        description: `${doc.title || filename} (${doc.document_type}) linked to this order.`,
      });

      return new Response(JSON.stringify({ success: true, matched: { document_id, order_id } }), { status: 200, headers: corsHeaders });
    }

    // ===== UNMATCH (move back to unmatched) =====
    if (action === "unmatch") {
      if (!document_id) return new Response(JSON.stringify({ success: false, error: "document_id required" }), { status: 200, headers: corsHeaders });

      await supabase.from("order_document_slots").update({
        is_filled: false, filled_at: null, document_id: null,
        line_items: [], base_model: null, chute_length: null, floor_type: null,
        subtotal: null, discount_amount: null, tax_amount: null, freight_amount: null, total_amount: null,
        raw_extracted_text: null, parsed_by: null, parse_confidence: null,
        comparison_status: null, comparison_notes: null, last_compared_at: null,
        updated_at: new Date().toISOString(),
      }).eq("document_id", document_id);

      const { error } = await supabase.from("order_documents").update({
        order_id: null, is_unmatched: true, match_attempted_at: new Date().toISOString(),
      }).eq("id", document_id);

      if (error) return new Response(JSON.stringify({ success: false, error: error.message }), { status: 200, headers: corsHeaders });
      return new Response(JSON.stringify({ success: true, unmatched: document_id }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ success: false, error: "Unknown action. Use: delete, match, unmatch" }), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), { status: 200, headers: corsHeaders });
  }
});
