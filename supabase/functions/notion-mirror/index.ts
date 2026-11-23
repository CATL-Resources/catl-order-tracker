// TITLE: Notion Mirror - Copy Tim's Notion Equipment Board Into The Hub
// Runs every 15 minutes from pg_cron (job notion-mirror-every-15min).
// ONE DIRECTION ONLY: reads Notion, writes the Hub. It never writes to Notion.
// Needs the NOTION_API_KEY secret (a Notion internal integration that the Equipment database is shared with).
// Each run is logged in notion_mirror_runs; the daily robot alarm emails equipment@ if it stalls.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DATABASE_ID = "6c37dfa15d7f47be8317cb104df0c668";
const NOTION_VERSION = "2022-06-28";

function text(p: any): string | null {
  if (!p) return null;
  const parts = p.title ?? p.rich_text;
  if (Array.isArray(parts)) {
    const s = parts.map((t: any) => t.plain_text ?? "").join("").trim();
    return s || null;
  }
  return null;
}
const multi = (p: any) => (p?.multi_select ?? []).map((o: any) => o.name);
const num = (p: any) => (p?.number ?? null) === null ? null : String(p.number);
const dateStart = (p: any) => p?.date?.start ?? null;

function flatten(page: any) {
  const pr = page.properties ?? {};
  return {
    notion_id: page.id,
    url: page.url,
    created_at: page.created_time,
    last_edited: page.last_edited_time,
    contract_name: text(pr["Contract Name"]),
    contract_number: num(pr["Contract #"]),
    catl_number: num(pr["CATL #"]),
    serial_number: text(pr["Serial #"]),
    customer: text(pr["Customer"]),
    customer_location: text(pr["Customer Location"]),
    phone: pr["Phone"]?.phone_number ?? null,
    email: pr["Email"]?.email ?? null,
    email_1: pr["Email 1"]?.email ?? null,
    manufacturer: pr["Manufacturer"]?.select?.name ?? null,
    type: pr["Type"]?.select?.name ?? null,
    description: text(pr["Description"]),
    power_unit: multi(pr["Ordered w/Power Unit Trailer"]),
    customer_mods: multi(pr["Customer CATL Mods"]),
    equipment_status: multi(pr["Equipment Status"]),
    transaction_status: multi(pr["Transaction Status"]),
    equip_location: multi(pr["Equip Location"]),
    est_completion: dateStart(pr["Est. Completion"]),
    order_date: dateStart(pr["Order Date"]),
    moly_dp: pr["Moly DP"]?.checkbox ?? false,
    contract_signed: pr["Contract Signed"]?.checkbox ?? false,
    truck: text(pr["Truck"]),
    delivery_instructions: text(pr["Delivery Instructions"]),
  };
}

Deno.serve(async (_req: Request) => {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const started = new Date().toISOString();
  const { data: run } = await supabase.from("notion_mirror_runs").insert({ source: "notion-mirror robot", started_at: started }).select("id").single();
  const finish = async (fields: Record<string, unknown>) => {
    if (run?.id) await supabase.from("notion_mirror_runs").update({ finished_at: new Date().toISOString(), ...fields }).eq("id", run.id);
    if (fields.ok === false) console.error("[notion-mirror] FAILED", JSON.stringify(fields));
    return new Response(JSON.stringify({ success: fields.ok !== false, ...fields }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const key = Deno.env.get("NOTION_API_KEY");
    if (!key) return await finish({ ok: false, error: "NOTION_API_KEY is not set. Chandy needs to create the Notion connection and save its key." });

    const pages: any[] = [];
    let cursor: string | undefined;
    do {
      const res = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
        body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
      });
      if (!res.ok) return await finish({ ok: false, error: `Notion said ${res.status}: ${(await res.text()).slice(0, 300)}` });
      const body = await res.json();
      pages.push(...body.results);
      cursor = body.has_more ? body.next_cursor : undefined;
    } while (cursor);

    if (pages.length < 50) return await finish({ ok: false, error: `Notion returned only ${pages.length} rows; refusing to mark the rest removed.` });

    const rows = pages.filter((p) => !p.archived && !p.in_trash).map(flatten);
    let updated = 0, created = 0;
    for (let i = 0; i < rows.length; i += 100) {
      const { data, error } = await supabase.rpc("notion_mirror_apply", { p_rows: rows.slice(i, i + 100) });
      if (error) return await finish({ ok: false, rows_seen: rows.length, error: `Saving rows failed: ${error.message}` });
      updated += data.orders_updated; created += data.orders_created;
    }
    const { data: fin, error: finErr } = await supabase.rpc("notion_mirror_finish", { p_run_started: started, p_full_run: true });
    if (finErr) return await finish({ ok: false, error: `Finish step failed: ${finErr.message}` });

    console.log("[notion-mirror] ok", rows.length, created, JSON.stringify(fin));
    return await finish({ ok: true, rows_seen: rows.length, orders_updated: updated, orders_created: created, error: null });
  } catch (err) {
    return await finish({ ok: false, error: String(err) });
  }
});
