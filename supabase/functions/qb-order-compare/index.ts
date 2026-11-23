// TITLE: QuickBooks Comparison - Which Orders Are Invoiced, Paid, And Billed, Plus Line Items For Unit Specs
// Runs every hour from pg_cron (job qb-order-compare-hourly).
// READ-ONLY against QuickBooks: it only runs SELECT queries. It never creates, changes or voids anything there.
// Pulls estimates, POs, bills, invoices and sales receipts since 2024 with their line items, finds contract / serial / CATL
// numbers in them, saves the copy in qb_docs + qb_doc_lines, then qb_compare_run() creates Daniels/Rawhide units,
// matches orders, refreshes unit specs and rebuilds qb_mismatches.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SINCE = "2024-01-01";
const TYPES = ["Invoice", "SalesReceipt", "Estimate", "PurchaseOrder", "Bill"];
const SERIAL_RE = /\bS[A-Z]{1,4}\d{4,6}\b|\bYR[A-Z]{0,3}\d{4,6}\b/g;

async function getQBToken(supabase: any) {
  const { data: tokenRow } = await supabase.from("qb_tokens").select("*").limit(1).single();
  if (!tokenRow) throw new Error("QuickBooks not connected");
  if (new Date(tokenRow.access_token_expires_at) > new Date(Date.now() + 60_000)) return tokenRow;
  const resp = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${Deno.env.get("QB_CLIENT_ID")}:${Deno.env.get("QB_CLIENT_SECRET")}`)}` },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokenRow.refresh_token }),
  });
  if (!resp.ok) throw new Error(`QuickBooks sign-in renewal failed: ${await resp.text()}`);
  const t = await resp.json();
  const now = Date.now();
  await supabase.from("qb_tokens").update({
    access_token: t.access_token, refresh_token: t.refresh_token,
    access_token_expires_at: new Date(now + t.expires_in * 1000).toISOString(),
    refresh_token_expires_at: new Date(now + (t.x_refresh_token_expires_in || 8726400) * 1000).toISOString(),
    updated_at: new Date(now).toISOString(),
  }).eq("id", tokenRow.id);
  return { ...tokenRow, access_token: t.access_token };
}

function uniq(a: string[]) { return [...new Set(a)]; }

function keysFrom(doc: any, type: string) {
  const parts: string[] = [doc.PrivateNote ?? "", doc.CustomerMemo?.value ?? "", doc.Memo ?? ""];
  for (const l of doc.Line ?? []) parts.push(l.Description ?? "");
  const textUp = parts.join(" \n ").toUpperCase();
  const serial = uniq([...textUp.matchAll(/\bS[A-Z]{1,4}\d{4,6}\b/g)].map((m) => m[0]));
  const catl = uniq([...textUp.matchAll(/\bCATL\s*#?\s*(\d{3,4})\b/g)].map((m) => m[1]));
  const contract = uniq([...textUp.matchAll(/\b(4\d{4})\b/g)].map((m) => m[1]));
  if ((type === "PurchaseOrder" || type === "Bill") && /^\d{5}$/.test(doc.DocNumber ?? "")) contract.push(doc.DocNumber);
  return { keys_serial: serial, keys_catl: catl, keys_contract: uniq(contract) };
}

function linesFrom(doc: any) {
  const out: any[] = [];
  (doc.Line ?? []).forEach((l: any, i: number) => {
    const det = l.ItemBasedExpenseLineDetail ?? l.SalesItemLineDetail ?? l.AccountBasedExpenseLineDetail;
    if (!det) return; // subtotal, discount and group header lines
    const desc = l.Description ?? null;
    out.push({
      line_no: Number(l.LineNum ?? i + 1),
      item_id: det.ItemRef?.value ?? null,
      item_name: det.ItemRef?.name ?? det.AccountRef?.name ?? null,
      description: desc,
      qty: det.Qty ?? null,
      unit_price: det.UnitPrice ?? null,
      amount: l.Amount ?? null,
      serials: uniq([...((desc ?? "").toUpperCase().matchAll(SERIAL_RE))].map((m) => m[0])),
    });
  });
  return out;
}

Deno.serve(async (_req: Request) => {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const started = new Date().toISOString();
  const { data: run } = await supabase.from("qb_compare_runs").insert({ started_at: started }).select("id").single();
  const finish = async (fields: Record<string, unknown>) => {
    if (run?.id) await supabase.from("qb_compare_runs").update({ finished_at: new Date().toISOString(), ...fields }).eq("id", run.id);
    if (fields.ok === false) console.error("[qb-order-compare] FAILED", JSON.stringify(fields));
    return new Response(JSON.stringify({ success: fields.ok !== false, ...fields }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const tok = await getQBToken(supabase);
    const base = Deno.env.get("QB_BASE_URL") || "https://quickbooks.api.intuit.com";
    let fetched = 0;
    for (const type of TYPES) {
      let start = 1;
      while (true) {
        const q = `SELECT * FROM ${type} WHERE TxnDate >= '${SINCE}' STARTPOSITION ${start} MAXRESULTS 500`;
        const res = await fetch(`${base}/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(q)}&minorversion=75`, {
          headers: { Authorization: `Bearer ${tok.access_token}`, Accept: "application/json" },
        });
        if (!res.ok) return await finish({ ok: false, docs_fetched: fetched, error: `QuickBooks ${type} query said ${res.status}: ${(await res.text()).slice(0, 300)}` });
        const body = await res.json();
        const list: any[] = body?.QueryResponse?.[type] ?? [];
        if (list.length === 0) break;
        const docs = list.map((d) => ({
          qb_type: type, qb_id: d.Id, doc_number: d.DocNumber ?? null, txn_date: d.TxnDate ?? null,
          party_name: d.CustomerRef?.name ?? d.VendorRef?.name ?? null,
          party_id: d.CustomerRef?.value ?? d.VendorRef?.value ?? null,
          total: d.TotalAmt ?? null, balance: d.Balance ?? null, ...keysFrom(d, type), lines: linesFrom(d),
        }));
        for (let i = 0; i < docs.length; i += 250) {
          const { error } = await supabase.rpc("qb_docs_save", { p_docs: docs.slice(i, i + 250) });
          if (error) return await finish({ ok: false, docs_fetched: fetched, error: `Saving ${type} failed: ${error.message}` });
        }
        fetched += list.length;
        if (list.length < 500) break;
        start += 500;
      }
    }
    if (fetched === 0) return await finish({ ok: false, docs_fetched: 0, error: "QuickBooks returned no documents; not rebuilding the list." });

    const { data, error } = await supabase.rpc("qb_compare_run", { p_fetch_started: started });
    if (error) return await finish({ ok: false, docs_fetched: fetched, error: `Matching failed: ${error.message}` });
    return await finish({ ok: true, docs_fetched: fetched, orders_checked: data.orders_checked, mismatches: data.mismatches, error: null });
  } catch (err) {
    return await finish({ ok: false, error: String(err) });
  }
});
