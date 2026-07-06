// compare-documents v7 — Handles info/base_model mapping types, uses our_item_id for matching
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };

interface CompareItem {
  mfg_name: string;
  our_name: string | null;
  mfg_price: number | null;
  our_cost: number | null;
  our_qty: number;
  status: "match" | "price_mismatch" | "mfg_only" | "catl_only" | "deposit" | "info";
  note: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const { order_id, mfg_so_text } = await req.json();
    if (!order_id) return new Response(JSON.stringify({ success: false, error: "order_id required" }), { headers: cors });

    const { data: order } = await supabase.from("orders")
      .select("*, base_models:base_model_id(id, name, cost_price, retail_price), manufacturers(id, name, short_name)")
      .eq("id", order_id).single();
    if (!order) return new Response(JSON.stringify({ success: false, error: "Order not found" }), { headers: cors });

    let soText = mfg_so_text || "";
    if (!soText) {
      const { data: slot } = await supabase.from("order_document_slots")
        .select("raw_extracted_text").eq("order_id", order_id).eq("slot_type", "mfg_sales_order").single();
      if (slot?.raw_extracted_text) soText = slot.raw_extracted_text;
    }

    // Get mappings for this manufacturer (now includes our_item_type)
    const { data: mappings } = await supabase.from("manufacturer_item_mappings")
      .select("mfg_item_name, our_item_name, our_item_id, our_item_type, confidence")
      .eq("manufacturer_id", order.manufacturer_id);

    const mfgToOurs: Map<string, any> = new Map();
    for (const m of (mappings || [])) {
      mfgToOurs.set((m.mfg_item_name || "").toLowerCase().trim(), m);
    }

    // Our options from the order — build lookups by BOTH name and option_id
    const ourOptions: any[] = Array.isArray(order.selected_options) ? order.selected_options : [];
    const ourByName: Map<string, any> = new Map();
    const ourById: Map<string, any> = new Map();
    for (const opt of ourOptions) {
      ourByName.set((opt.name || "").toLowerCase().trim(), opt);
      if (opt.option_id) ourById.set(opt.option_id, opt);
    }

    // Also track the base model from the order for base_model type mappings
    const baseModel = order.base_models;
    const baseModelId = order.base_model_id;

    if (!soText) return doTotalComparison(order_id, order, ourOptions);
    const soLines = parseMolySO(soText);
    if (soLines.length === 0) return doTotalComparison(order_id, order, ourOptions);

    // Compare line by line
    const items: CompareItem[] = [];
    const matchedOurNames = new Set<string>();
    const matchedOurIds = new Set<string>();
    let baseModelMatched = false;

    for (const line of soLines) {
      const mfgName = line.description.trim();
      const mfgLower = mfgName.toLowerCase();

      // Skip deposits/payments
      if (/deposit|payment|\bACH\b|\bLPPD\b/i.test(mfgName)) {
        items.push({ mfg_name: mfgName, our_name: null, mfg_price: line.netPrice, our_cost: null, our_qty: 0, status: "deposit", note: "Down payment — excluded from comparison" });
        continue;
      }
      // Skip freight/surcharge/tax by regex
      if (/freight|surcharge|tax/i.test(mfgName)) {
        items.push({ mfg_name: mfgName, our_name: null, mfg_price: line.netPrice, our_cost: null, our_qty: 0, status: "info", note: "Not a line item" });
        continue;
      }

      // Look up mapping
      const mapping = mfgToOurs.get(mfgLower);

      // ---- INFO TYPE: skip with note ----
      if (mapping && mapping.our_item_type === "info") {
        items.push({
          mfg_name: mfgName, our_name: mapping.our_item_name,
          mfg_price: line.netPrice, our_cost: null, our_qty: 0,
          status: "info", note: mapping.our_item_name || "Informational line — not compared",
        });
        continue;
      }

      // ---- BASE MODEL TYPE: compare against order's base model ----
      if (mapping && mapping.our_item_type === "base_model") {
        // Check if this mapping's our_item_id matches the order's base_model_id
        if (mapping.our_item_id && baseModelId && mapping.our_item_id === baseModelId) {
          baseModelMatched = true;
          // Get cost from the frozen selected_options base model entry
          const frozenBase = ourOptions.find((o: any) => o.is_base_model === true);
          const ourCost = frozenBase?.cost_price_each ?? frozenBase?.cost_price ?? baseModel?.cost_price ?? 0;
          const priceDiff = line.netPrice != null ? Math.abs(line.netPrice - ourCost) : 0;
          const priceMatch = line.netPrice == null || priceDiff < 1;
          items.push({
            mfg_name: mfgName, our_name: baseModel?.name || mapping.our_item_name,
            mfg_price: line.netPrice, our_cost: ourCost, our_qty: 1,
            status: priceMatch ? "match" : "price_mismatch",
            note: priceMatch ? null : `Base model price diff: $${priceDiff.toFixed(2)} (Mfg: $${line.netPrice?.toFixed(2)} vs Ours: $${ourCost.toFixed(2)})`,
          });
        } else {
          // Base model mismatch — Moly built a different model than we ordered
          items.push({
            mfg_name: mfgName, our_name: baseModel?.name || null,
            mfg_price: line.netPrice, our_cost: baseModel?.cost_price || null, our_qty: 1,
            status: "mfg_only",
            note: `Mfg base model "${mapping.our_item_name}" doesn't match our order's "${baseModel?.name || 'unknown'}"`,
          });
        }
        continue;
      }

      // ---- OPTION TYPE (or unmapped): match by our_item_id first, then name ----
      let ourOpt: any = null;

      if (mapping) {
        // Try matching by our_item_id (strongest match)
        if (mapping.our_item_id) {
          ourOpt = ourById.get(mapping.our_item_id);
        }
        // Fall back to name match
        if (!ourOpt) {
          ourOpt = ourByName.get((mapping.our_item_name || "").toLowerCase().trim());
        }
      } else {
        // No mapping — try direct/fuzzy name match
        ourOpt = ourByName.get(mfgLower);
        if (!ourOpt) {
          for (const [key, val] of ourByName) {
            if (key.includes(mfgLower) || mfgLower.includes(key)) { ourOpt = val; break; }
          }
        }
      }

      if (ourOpt) {
        matchedOurNames.add((ourOpt.name || "").toLowerCase().trim());
        if (ourOpt.option_id) matchedOurIds.add(ourOpt.option_id);
        const ourCostTotal = (ourOpt.cost_price_each || 0) * (ourOpt.quantity || 1);
        const priceDiff = line.netPrice != null ? Math.abs(line.netPrice - ourCostTotal) : 0;
        const priceMatch = line.netPrice == null || priceDiff < 1;

        items.push({
          mfg_name: mfgName, our_name: ourOpt.name,
          mfg_price: line.netPrice, our_cost: ourCostTotal, our_qty: ourOpt.quantity || 1,
          status: priceMatch ? "match" : "price_mismatch",
          note: priceMatch ? null : `Price diff: $${priceDiff.toFixed(2)} (Mfg: $${line.netPrice?.toFixed(2)} vs Ours: $${ourCostTotal.toFixed(2)})`,
        });
      } else {
        items.push({
          mfg_name: mfgName, our_name: null, mfg_price: line.netPrice, our_cost: null, our_qty: 0,
          status: "mfg_only",
          note: mapping ? `Mapped to "${mapping.our_item_name}" but not on this order` : "No mapping found — add to manufacturer_item_mappings",
        });
      }
    }

    // Find CATL options not on the Moly SO (skip base model if already matched)
    for (const opt of ourOptions) {
      if (opt.is_base_model) continue; // base model handled separately above
      const optLower = (opt.name || "").toLowerCase().trim();
      const alreadyMatched = matchedOurNames.has(optLower) || (opt.option_id && matchedOurIds.has(opt.option_id));
      if (!alreadyMatched) {
        items.push({
          mfg_name: "—", our_name: opt.name,
          mfg_price: null, our_cost: (opt.cost_price_each || 0) * (opt.quantity || 1), our_qty: opt.quantity || 1,
          status: "catl_only",
          note: `${opt.name} is on our PO but NOT on Mfg SO`,
        });
      }
    }

    // Summary counts
    const matches = items.filter(i => i.status === "match").length;
    const priceMismatches = items.filter(i => i.status === "price_mismatch").length;
    const mfgOnly = items.filter(i => i.status === "mfg_only").length;
    const catlOnly = items.filter(i => i.status === "catl_only").length;
    const deposits = items.filter(i => i.status === "deposit").length;
    const infoItems = items.filter(i => i.status === "info").length;
    const hasIssues = priceMismatches > 0 || mfgOnly > 0 || catlOnly > 0;

    const mfgTotal = items.filter(i => i.status !== "deposit" && i.status !== "info" && i.mfg_price).reduce((s, i) => s + (i.mfg_price || 0), 0);
    const ourTotal = ourOptions.reduce((s, o) => s + (o.cost_price_each || 0) * (o.quantity || 1), 0);

    const compStatus = hasIssues ? "mismatch" : "match";
    const compNotes = hasIssues
      ? `${priceMismatches} price diff(s), ${mfgOnly} Mfg-only, ${catlOnly} PO-only${infoItems ? `, ${infoItems} info` : ""}${deposits ? `, ${deposits} deposit(s)` : ""}`
      : `All ${matches} items match${infoItems ? ` (${infoItems} info items skipped)` : ""}${deposits ? ` (${deposits} deposit(s) excluded)` : ""}`;

    await supabase.from("order_document_slots").update({
      comparison_status: compStatus, comparison_notes: compNotes,
      last_compared_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("order_id", order_id).eq("slot_type", "mfg_sales_order");

    return new Response(JSON.stringify({
      success: true, order_id, compare_mode: "line_items",
      summary: { matches, price_mismatches: priceMismatches, mfg_only: mfgOnly, catl_only: catlOnly, info: infoItems, deposits, has_issues: hasIssues, mfg_total: mfgTotal, our_total: ourTotal, total_diff: mfgTotal - ourTotal },
      items, notes: compNotes,
    }), { headers: cors });
  } catch (err: any) {
    console.error("compare-documents error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), { headers: cors });
  }
});

// ---- TOTAL-ONLY COMPARISON ----
function doTotalComparison(orderId: string, order: any, ourOptions: any[]) {
  const ourCostTotal = ourOptions.reduce((s: number, o: any) => s + (o.cost_price_each || 0) * (o.quantity || 1), 0);
  const mfgInvoiceTotal = order.moly_invoice_total || null;
  const items: any[] = [
    { key: "our_cost", label: "Our Cost (from options)", value: ourCostTotal },
    { key: "subtotal", label: "Order Subtotal", value: Number(order.subtotal || 0) },
    { key: "customer_price", label: "Customer Price", value: Number(order.customer_price || 0) },
  ];
  if (mfgInvoiceTotal) items.push({ key: "mfg_invoice_total", label: "Mfg Invoice Total", value: Number(mfgInvoiceTotal) });

  let hasIssues = false; let notes = "";
  if (mfgInvoiceTotal && ourCostTotal) {
    const diff = Number(mfgInvoiceTotal) - ourCostTotal;
    if (Math.abs(diff) < 1) notes = `Totals match: $${ourCostTotal.toLocaleString()}`;
    else { hasIssues = true; notes = `Diff: $${diff > 0 ? "+" : ""}${diff.toFixed(2)} (Invoice $${Number(mfgInvoiceTotal).toLocaleString()} vs Our Cost $${ourCostTotal.toLocaleString()})`; }
  } else {
    notes = !mfgInvoiceTotal ? "No Mfg invoice total on file. Upload the SO to get itemized comparison." : "Total-only comparison.";
  }

  supabase.from("order_document_slots").update({
    comparison_status: hasIssues ? "mismatch" : (mfgInvoiceTotal ? "match" : "pending"),
    comparison_notes: notes, last_compared_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("order_id", orderId).eq("slot_type", "mfg_sales_order").then(() => {});

  return new Response(JSON.stringify({
    success: true, order_id: orderId, compare_mode: "total_only",
    summary: { our_cost: ourCostTotal, mfg_invoice_total: mfgInvoiceTotal ? Number(mfgInvoiceTotal) : null, has_issues: hasIssues },
    items, notes,
  }), { headers: cors });
}

// ---- Moly SO Text Parser ----
interface SOLine { description: string; listPrice: number | null; discountPct: number | null; netPrice: number | null; }
function parseMolySO(text: string): SOLine[] {
  const lines: SOLine[] = []; const rows = text.split('\n');
  for (const row of rows) {
    const trimmed = row.trim(); if (!trimmed) continue;
    if (/^(Sales Order|Moly Manufacturing|Sold To|Ship To|Page:|Signature|Payment|All final|Freight F\.O\.B|Customer responsible|A 15%|Please sign|ARRANGEMENTS|INVOICE DATE|Material Surcharge)/i.test(trimmed)) continue;
    if (/^(List Price|Discount Amount|Subtotal Amount|Order Total|Sales Tax):?/i.test(trimmed)) continue;
    if (/^SILENCER\s+(WB|MAXX|HD|STD|TILT|Ranch|CP)/i.test(trimmed)) continue;

    const priceMatch = trimmed.match(/^(.+?)\s+(\d[\d,]*\.\d{2})\s+(\d+)%\s+([\d,]+\.\d{2})/);
    if (priceMatch) {
      lines.push({ description: priceMatch[1].trim(), listPrice: parseFloat(priceMatch[2].replace(/,/g, '')), discountPct: parseInt(priceMatch[3]), netPrice: parseFloat(priceMatch[4].replace(/,/g, '')) });
      continue;
    }
    const singlePrice = trimmed.match(/^(.+?)\s+(-?\d[\d,]*\.\d{2})\s*$/);
    if (singlePrice) {
      lines.push({ description: singlePrice[1].trim(), listPrice: null, discountPct: null, netPrice: parseFloat(singlePrice[2].replace(/,/g, '')) });
      continue;
    }
    if (/^\/?LPPD/i.test(trimmed)) {
      const amt = trimmed.match(/-?\d[\d,]*\.\d{2}/);
      lines.push({ description: "Less Prepaid Deposit (LPPD)", listPrice: null, discountPct: null, netPrice: amt ? parseFloat(amt[0].replace(/,/g, '')) : null });
      continue;
    }
    if (/^ACH Received/i.test(trimmed)) {
      const amt = trimmed.match(/-?\d[\d,]*\.\d{2}/);
      lines.push({ description: "ACH Payment Received", listPrice: null, discountPct: null, netPrice: amt ? parseFloat(amt[0].replace(/,/g, '')) : null });
      continue;
    }
  }
  return lines;
}
