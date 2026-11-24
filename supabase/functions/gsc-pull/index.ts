// TITLE: Search Console Pull - What People Typed Into Google Before Seeing catlresources.com
// Runs once a day from pg_cron (job gsc-pull-daily). READ-ONLY on Google.
// Sign-in: google_tokens_gsc (made by google-oauth-callback?action=auth_url&purpose=gsc, the
// "Connect Google Search Console" button on Hub > Equipment > Website Analytics). It never touches
// google_tokens (Tim's Drive/Gmail sign-in).
// Writes search_console_daily: one row per day x search x page x device, plus one totals row per day
// (query = page = device = ''). Google revises the last few days, so each run re-pulls from 4 days
// before the newest day it already has.
// Every run is logged in gsc_pull_runs; robot_health_run() alarms if a connected pull stops working.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

type TokenRow = { id: string; account_email: string | null; access_token: string | null; refresh_token: string | null; access_token_expires_at: string | null; site_url: string | null };
type GscRow = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };

const day = (d: Date) => d.toISOString().slice(0, 10);

async function freshToken(supabase: SupabaseClient, row: TokenRow): Promise<string> {
  if (row.access_token && new Date(row.access_token_expires_at || 0) > new Date(Date.now() + 60_000)) return row.access_token;
  const cid = Deno.env.get("GOOGLE_CLIENT_ID"), cs = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!cid || !cs) throw new Error("GOOGLE_CLIENT_ID/SECRET not set");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cid, client_secret: cs, refresh_token: row.refresh_token || "", grant_type: "refresh_token" }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("Google sign-in renewal failed (" + (j.error_description || j.error || r.status) + "). Press Connect Google Search Console in the Hub again.");
  const { error } = await supabase.from("google_tokens_gsc").update({
    access_token: j.access_token, access_token_expires_at: new Date(Date.now() + (j.expires_in || 3600) * 1000).toISOString(), updated_at: new Date().toISOString(),
  }).eq("id", row.id);
  if (error) throw new Error("Could not save the renewed sign-in: " + error.message);
  return j.access_token;
}

async function query(token: string, site: string, body: Record<string, unknown>): Promise<GscRow[]> {
  const out: GscRow[] = [];
  for (let startRow = 0; startRow < 100_000; startRow += 25_000) {
    const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, rowLimit: 25_000, startRow, dataState: "all" }),
    });
    if (!r.ok) throw new Error(`Search Console said ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const rows: GscRow[] = (await r.json()).rows || [];
    out.push(...rows);
    if (rows.length < 25_000) break;
  }
  return out;
}

Deno.serve(async (_req: Request) => {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const started = new Date().toISOString();
  const log = async (ok: boolean, rows: number, note: string | null, error: string | null) => {
    const { error: e } = await supabase.from("gsc_pull_runs").insert({ started_at: started, finished_at: new Date().toISOString(), ok, rows_saved: rows, note, error });
    if (e) console.error("[gsc] could not write run log", e.message);
  };
  try {
    const { data: tok, error: tokErr } = await supabase.from("google_tokens_gsc").select("*").order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (tokErr) throw new Error("Could not read the Search Console sign-in: " + tokErr.message);
    if (!tok || !tok.refresh_token) {
      await log(true, 0, "Not connected yet", null);
      return Response.json({ ok: true, note: "Search Console not connected yet" });
    }
    if (!tok.site_url) throw new Error(`${tok.account_email} does not own catlresources.com in Search Console. Finish verification, then press Connect again.`);
    const token = await freshToken(supabase, tok as TokenRow);

    const { data: last, error: lastErr } = await supabase.from("search_console_daily").select("day").order("day", { ascending: false }).limit(1).maybeSingle();
    if (lastErr) throw new Error("Could not read saved days: " + lastErr.message);
    const end = new Date(Date.now() - 86400_000);
    const start = last?.day ? new Date(new Date(last.day).getTime() - 4 * 86400_000) : new Date(Date.now() - 480 * 86400_000);
    const range = { startDate: day(start), endDate: day(end) };

    const detail = await query(token, tok.site_url, { ...range, dimensions: ["date", "query", "page", "device"] });
    const totals = await query(token, tok.site_url, { ...range, dimensions: ["date"] });
    const pulled_at = new Date().toISOString();
    const rows = [
      ...detail.map((r) => ({ day: r.keys[0], query: r.keys[1] || "", page: r.keys[2] || "", device: (r.keys[3] || "").toLowerCase(),
        clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position, pulled_at })),
      ...totals.map((r) => ({ day: r.keys[0], query: "", page: "", device: "", clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position, pulled_at })),
    ];
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from("search_console_daily").upsert(rows.slice(i, i + 500), { onConflict: "day,query,page,device" });
      if (error) throw new Error("Could not save search numbers: " + error.message);
    }
    await log(true, rows.length, `${tok.site_url} ${range.startDate}..${range.endDate}`, null);
    return Response.json({ ok: true, site: tok.site_url, ...range, rows: rows.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[gsc] failed", msg);
    await log(false, 0, null, msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
});
