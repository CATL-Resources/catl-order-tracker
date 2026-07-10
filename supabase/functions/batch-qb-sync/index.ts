// batch-qb-sync v3 — Throttled: processes orders one at a time with delays to avoid QB rate limits
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const body = await req.json();
    const mode = body.mode || "unfilled_estimates"; // unfilled_estimates | unfilled_invoices | all_unfilled
    const limit = body.limit || 5; // max orders per batch
    const delayMs = body.delay_ms || 3000; // delay between QB calls

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const fnUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/qb-check-sync`;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Find orders that need syncing
    let query = supabase.from("orders").select("id, moly_contract_number, contract_name, qb_estimate_id, qb_invoice_id, qb_bill_id");

    if (mode === "unfilled_estimates") {
      query = query.not("qb_estimate_id", "is", null);
    } else if (mode === "unfilled_invoices") {
      query = query.not("qb_invoice_id", "is", null);
    } else {
      // all_unfilled: any order with a QB doc ID that might need slot filling
      query = query.or("qb_estimate_id.not.is.null,qb_invoice_id.not.is.null,qb_bill_id.not.is.null");
    }

    const { data: orders, error: ordErr } = await query.order("moly_contract_number").limit(limit);
    if (ordErr) throw ordErr;
    if (!orders || orders.length === 0) {
      return new Response(JSON.stringify({ success: true, summary: "No orders need syncing", results: [] }), { headers: cors });
    }

    // Filter to orders where the relevant slot is still empty
    const needsSync: any[] = [];
    for (const order of orders) {
      const { data: slots } = await supabase.from("order_document_slots")
        .select("slot_type, is_filled")
        .eq("order_id", order.id)
        .in("slot_type", ["approved_estimate", "catl_customer_invoice", "qb_bill"]);

      const estSlot = slots?.find((s: any) => s.slot_type === "approved_estimate");
      const invSlot = slots?.find((s: any) => s.slot_type === "catl_customer_invoice");
      const billSlot = slots?.find((s: any) => s.slot_type === "qb_bill");

      const needsEst = order.qb_estimate_id && !estSlot?.is_filled;
      const needsInv = order.qb_invoice_id && !invSlot?.is_filled;
      const needsBill = order.qb_bill_id && !billSlot?.is_filled;

      if (needsEst || needsInv || needsBill) {
        needsSync.push({ ...order, needs_est: needsEst, needs_inv: needsInv, needs_bill: needsBill });
      }
    }

    if (needsSync.length === 0) {
      return new Response(JSON.stringify({ success: true, summary: "All slots already filled", results: [] }), { headers: cors });
    }

    // Process one at a time with delay
    const results: any[] = [];
    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < needsSync.length; i++) {
      const order = needsSync[i];

      if (i > 0) await sleep(delayMs); // throttle between calls

      try {
        const resp = await fetch(fnUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
          body: JSON.stringify({ order_id: order.id }),
        });
        const data = await resp.json();

        results.push({
          contract: order.moly_contract_number || order.contract_name,
          success: data.success,
          summary: data.summary,
          downloads: data.downloads ? Object.entries(data.downloads).map(([k, v]: [string, any]) => `${k}: ${v.success ? (v.already_filled ? 'already filled' : 'downloaded') : v.error}`).join(", ") : "none",
        });

        if (data.success && !data.has_issues) successCount++;
        else if (!data.success) errorCount++;
      } catch (e: any) {
        results.push({ contract: order.moly_contract_number || order.contract_name, success: false, error: e.message });
        errorCount++;
      }
    }

    return new Response(JSON.stringify({
      success: true,
      summary: `Processed ${needsSync.length} orders: ${successCount} clean, ${errorCount} errors`,
      total: needsSync.length,
      results,
    }), { headers: cors });
  } catch (err: any) {
    console.error("batch-qb-sync error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), { headers: cors });
  }
});
