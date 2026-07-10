// chat-assistant v13 — Focused snapshot: active orders only, new emails surfaced first, no stale rehashing
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function cdtNow(): string { return new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }); }
function isoDate(): string { const d = new Date(); const cdt = new Date(d.toLocaleString("en-US", { timeZone: "America/Chicago" })); return cdt.toISOString().split("T")[0]; }
function daysAgo(iso: string): number { return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000); }

interface ActionResult { type: string; success: boolean; [key: string]: any; }
type Tier = "simple" | "ops" | "spec" | "report";

function classifyMessage(message: string): Tier {
  const msg = message.toLowerCase().trim();
  if (/^(hey|hi|hello|howdy|yo|sup|thanks|thank you|ok|okay|got it|sounds good|yes|no|yep|nope|cool|nice|good|great|perfect|sure|bye|later|morning|afternoon|evening)\b/i.test(msg) && msg.length < 40) return "simple";
  if (/\b(morning report|daily report|eod|end of day|full report|what.?s (on my plate|happening|going on)|give me everything|dashboard|overview|status report|wrap up|run ?down)\b/i.test(msg)) return "report";
  if (/\b(spec out|spec me|price out|price a|quote (a|me|for)|how much (is|does|for|would)|configure|build a quote|what.?s the (price|cost|retail|margin) (of|on|for))\b/i.test(msg)) return "spec";
  if (/\b(silencer|ranch hd|maxx|cp |tilt|wide body|rawhide|daniels|mje|conquistador|linn)\b/i.test(msg) && /\b(price|cost|retail|margin|spec|quote|estimate)\b/i.test(msg)) return "spec";
  return "ops";
}

// Active statuses — these are orders Tim is actively working
const ACTIVE_STATUSES = ["estimate", "purchase_order", "order_pending", "building", "ready", "in_transit", "at_catl"];

async function getOrBuildSnapshot(supabase: any, tier: Tier, message: string): Promise<{ snapshot: string; tasks: any[] }> {
  if (tier === "simple") return { snapshot: "", tasks: [] };

  const today = isoDate();

  // Run all queries in parallel
  const [
    tasksRes,
    activeOrdersRes,
    allOrdersRes,
    emailsRes,
    estimatesRes,
  ] = await Promise.all([
    supabase.from("tasks").select("id, title, status, priority, due_date, order_id, task_type, source_type, created_at, assigned_to").eq("status", "open").order("due_date", { ascending: true, nullsFirst: false }),
    // Active orders only (not delivered/closed) — full detail
    supabase.from("orders").select("id, contract_name, moly_contract_number, status, customer_id, from_inventory, qb_po_id, qb_estimate_id, qb_bill_id, qb_invoice_id, google_drive_folder_url, est_completion_date, updated_at, manufacturers(name, short_name), base_models:base_model_id(name), customers(name)").in("status", ACTIVE_STATUSES).order("updated_at", { ascending: false }),
    // Delivered orders — summary only (don't spam the context)
    supabase.from("orders").select("id, contract_name, moly_contract_number, status, updated_at").eq("status", "delivered").order("updated_at", { ascending: false }).limit(5),
    // Emails — recent 20, equipment-flagged ones first
    supabase.from("gmail_inbox").select("id, from_name, from_email, to_email, subject, snippet, has_attachment, received_at, is_equipment_related, matched_contract_number, ai_category").order("received_at", { ascending: false }).limit(40),
    // Open estimates
    supabase.from("estimates").select("id, estimate_number, contract_name, status, total_price, emailed_at, created_at, customers(name)").eq("converted_to_order", false).order("created_at", { ascending: false }).limit(15),
  ]);

  const tasks = tasksRes.data || [];
  const activeOrders = activeOrdersRes.data || [];
  const recentDelivered = allOrdersRes.data || [];
  const allEmails = emailsRes.data || [];
  const estimates = estimatesRes.data || [];

  // Split emails: equipment-related vs other, and new (last 24h) vs older
  const equipmentEmails = allEmails.filter((e: any) => e.is_equipment_related);
  const newEquipmentEmails = equipmentEmails.filter((e: any) => daysAgo(e.received_at) < 1);
  const recentEquipmentEmails = equipmentEmails.filter((e: any) => daysAgo(e.received_at) < 7);
  const otherRecentEmails = allEmails.filter((e: any) => !e.is_equipment_related && daysAgo(e.received_at) < 3).slice(0, 5);

  const lines: string[] = [];

  // ── 1. NEW EQUIPMENT EMAILS — surface prominently ──────────────────────────
  if (newEquipmentEmails.length > 0) {
    lines.push(`## 🔔 NEW EQUIPMENT EMAILS TODAY (${newEquipmentEmails.length} — ACT ON THESE):`);
    for (const e of newEquipmentEmails) {
      const dir = e.from_email?.toLowerCase().includes("timselect") ? "→ SENT" : "← FROM";
      const linked = e.matched_contract_number ? ` [Contract ${e.matched_contract_number}]` : "";
      const att = e.has_attachment ? " [HAS ATTACHMENT]" : "";
      lines.push(`- ${dir} ${e.from_name || e.from_email} | "${e.subject}"${linked}${att}`);
      if (e.snippet) lines.push(`  > ${e.snippet.substring(0, 150)}`);
    }
  }

  // ── 2. TASKS ───────────────────────────────────────────────────────────────
  const overdue = tasks.filter((t: any) => t.due_date && t.due_date < today);
  const dueToday = tasks.filter((t: any) => t.due_date === today);
  const upcoming = tasks.filter((t: any) => t.due_date && t.due_date > today);
  const noDue = tasks.filter((t: any) => !t.due_date);
  lines.push(`\n## TASKS: ${tasks.length} open`);
  if (overdue.length) lines.push(`⚠️ OVERDUE (${overdue.length}): ${overdue.map((t: any) => `"${t.title}" due ${t.due_date}${t.assigned_to ? ` @${t.assigned_to}` : ""}`).join("; ")}`);
  if (dueToday.length) lines.push(`TODAY (${dueToday.length}): ${dueToday.map((t: any) => `"${t.title}"${t.assigned_to ? ` @${t.assigned_to}` : ""}`).join("; ")}`);
  if (upcoming.length) lines.push(`UPCOMING: ${upcoming.slice(0, 5).map((t: any) => `"${t.title}" due ${t.due_date}`).join("; ")}`);
  if (noDue.length) lines.push(`NO DATE (${noDue.length}): ${noDue.slice(0, 5).map((t: any) => `"${t.title}"${t.assigned_to ? ` @${t.assigned_to}` : ""}`).join("; ")}`);

  // ── 3. ACTIVE ORDERS (the ones Tim is working right now) ───────────────────
  lines.push(`\n## ACTIVE ORDERS: ${activeOrders.length} in pipeline`);
  lines.push(`(These are orders NOT yet delivered. Delivered orders are summarized at the bottom.)`);
  for (const o of activeOrders) {
    const customer = (o.customers as any)?.name || (o.customer_id ? "customer assigned" : "INVENTORY");
    const eta = o.est_completion_date ? ` | ETA ${o.est_completion_date}${o.est_completion_date < today ? " ⚠️OVERDUE" : ""}` : "";
    const docs = [o.qb_po_id ? "✓PO" : "✗PO", o.qb_bill_id ? "✓Bill" : "✗Bill"].join(" ");
    const drive = o.google_drive_folder_url ? "✓Drive" : "✗Drive";
    lines.push(`- ${o.moly_contract_number || "?"} ${o.contract_name || "unnamed"} | ${o.status} | ${o.base_models?.name || "?"} | ${customer}${eta} | ${docs} ${drive}`);
  }
  if (activeOrders.length === 0) lines.push("- No active orders in pipeline");

  // ── 4. RECENT DELIVERED (brief — don't rehash these) ──────────────────────
  if (recentDelivered.length > 0) {
    lines.push(`\n## RECENTLY DELIVERED (${recentDelivered.length} shown, do not bring these up unless asked):`);
    for (const o of recentDelivered) lines.push(`- ${o.moly_contract_number || "?"} ${o.contract_name || ""} delivered`);
  }

  // ── 5. OPEN ESTIMATES ─────────────────────────────────────────────────────
  if (estimates.length > 0) {
    const stale = estimates.filter((e: any) => daysAgo(e.created_at) > 14);
    lines.push(`\n## OPEN ESTIMATES: ${estimates.length}${stale.length > 0 ? ` (${stale.length} stale >14 days)` : ""}`);
    for (const e of estimates.slice(0, 8)) {
      const age = daysAgo(e.created_at);
      lines.push(`- ${e.estimate_number} ${e.contract_name || ""} $${e.total_price || 0} | ${e.customers?.name || "unknown"} | ${e.emailed_at ? "sent" : "NOT SENT"} | ${age}d old`);
    }
  }

  // ── 6. GMAIL — equipment emails this week, brief ──────────────────────────
  lines.push(`\n## GMAIL INBOX — Tim: timselect@gmail.com`);
  lines.push(`Equipment-related this week: ${recentEquipmentEmails.length}`);
  if (recentEquipmentEmails.length > 0) {
    lines.push("Equipment emails (newest first):");
    for (const e of recentEquipmentEmails.slice(0, 15)) {
      const dir = e.from_email?.toLowerCase().includes("timselect") ? "→ SENT" : "← FROM";
      const linked = e.matched_contract_number ? ` [#${e.matched_contract_number}]` : "";
      const att = e.has_attachment ? " [ATT]" : "";
      const age = daysAgo(e.received_at);
      lines.push(`- ${dir} ${e.from_name || e.from_email} | "${e.subject}" | ${age === 0 ? "TODAY" : age + "d ago"}${linked}${att}`);
    }
  }
  if (otherRecentEmails.length > 0) {
    lines.push("Other recent non-junk emails:");
    for (const e of otherRecentEmails) {
      const dir = e.from_email?.toLowerCase().includes("timselect") ? "→" : "←";
      lines.push(`- ${dir} ${e.from_name || e.from_email} | "${e.subject}"`);
    }
  }

  // ── 7. REPORT tier extras ─────────────────────────────────────────────────
  if (tier === "report") {
    const [memosRes, timelineRes] = await Promise.all([
      supabase.from("voice_memos").select("id, ai_summary, memo_type, created_at, notes").eq("archived", false).eq("processing_status", "complete").order("created_at", { ascending: false }).limit(8),
      supabase.from("order_timeline").select("id, order_id, event_type, title, created_at").order("created_at", { ascending: false }).limit(15),
    ]);
    const memos = memosRes.data || [];
    if (memos.length > 0) {
      lines.push(`\n## RECENT MEMOS (${memos.length}):`);
      for (const m of memos) lines.push(`- ${m.memo_type || "note"} (${daysAgo(m.created_at)}d ago): ${(m.ai_summary || m.notes || "").substring(0, 100)}`);
    }
    const timeline = timelineRes.data || [];
    if (timeline.length > 0) {
      lines.push(`\n## RECENT ACTIVITY (${timeline.length} events):`);
      for (const t of timeline.slice(0, 8)) lines.push(`- ${t.event_type}: ${t.title} (${daysAgo(t.created_at)}d ago)`);
    }
  }

  return { snapshot: lines.join("\n"), tasks };
}

function buildSystemPrompt(tier: Tier, snapshot: string): string {
  const base = `You are the CattleHQ Assistant — the operations brain for CATL Resources Livestock Equipment. Tim Olson is the equipment salesman you serve.
Current time: ${cdtNow()} CDT | Today: ${isoDate()}
Speak in rancher language. Brief. Bullets. No corporate fluff.`;

  if (tier === "simple") return `${base}\nYou're Tim's assistant. Keep it brief and friendly.`;

  const taskRules = `
TASK RULES (NON-NEGOTIABLE):
- ONLY create tasks when Tim EXPLICITLY says "add a task", "remind me to", "create a task for".
- NEVER auto-create tasks. NEVER create nag/reminder tasks. NEVER prefix with URGENT/IMMEDIATE/CRITICAL.
- You can mention overdue items in your response — do NOT create a task for them.`;

  const freshnesRules = `
FRESHNESS RULES (CRITICAL):
- ALWAYS lead with what's NEW: today's emails, tasks due today/overdue, status changes.
- NEVER volunteer information about DELIVERED orders unless Tim asks.
- NEVER bring up old issues Tim hasn't asked about.
- If Tim just responded to your last message, stay on THAT topic — don't switch to something else.
- "Recently delivered" orders in the data = DONE. Do not mention them proactively.`;

  if (tier === "spec") return `${base}\n${snapshot}`;

  return `${base}
${freshnesRules}
${taskRules}

You have FULL ACCESS to:
- All active orders (not delivered/closed)
- Tim's Gmail inbox (recent emails)
- Open tasks and estimates
- NEVER say you cannot see email — it's in the data below.
- If an email isn't shown, say "not in the last 40 messages — trigger a Gmail scan?"

Actions (stripped from response before showing Tim):
- [ACTION:CREATE_TASK title="..." due_date="YYYY-MM-DD" priority="normal" order_id="..." assigned_to="..."]
- [ACTION:COMPLETE_TASK task_id="..."]
- [ACTION:LOG_NOTE order_id="..." title="..." description="..."]
- [ACTION:ADD_TIMELINE order_id="..." event_type="note" title="..." description="..."]
- [ACTION:UPDATE_STATUS order_id="..." new_status="..."]
- [ACTION:TRIGGER_GMAIL_SCAN]
- [ACTION:TRIGGER_DRIVE_SCAN order_id="..."]
- [ACTION:TRIGGER_QB_SYNC order_id="..."]

Assigned_to: Tim, Caleb, Chandy, Jen

Rules: Bullets. Bold key info. Under 350 words unless asked for detail.

${snapshot}`;
}

function pickModel(tier: Tier): string { return tier === "simple" ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-20250514"; }
function pickMaxTokens(tier: Tier): number { return tier === "simple" ? 300 : tier === "ops" ? 1200 : tier === "spec" ? 2000 : 2000; }

function normalizeTitle(t: string): string { return (t||"").toLowerCase().replace(/[^a-z0-9\s]/g,"").replace(/\b(the|a|an|for|to|on|in|at|of|with|and|or)\b/g,"").replace(/\s+/g," ").trim().split(" ").sort().join(" "); }

async function deduplicateTasks(supabase: any, tasks: any[], actions: ActionResult[]): Promise<any[]> {
  const groups = new Map<string, any[]>();
  for (const t of tasks) { const k = normalizeTitle(t.title); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(t); }
  const kept: any[] = [];
  for (const [, group] of groups) {
    if (group.length <= 1) { kept.push(group[0]); continue; }
    group.sort((a: any, b: any) => (a.due_date && !b.due_date ? -1 : !a.due_date && b.due_date ? 1 : 0));
    kept.push(group[0]);
    const del = group.slice(1).map((t: any) => t.id);
    if (del.length) { await supabase.from("tasks").delete().in("id", del); actions.push({ type: "tasks_deduped", success: true, deleted_count: del.length }); }
  }
  return kept;
}

const BLOCKED_TASK_PATTERNS = [
  /^(URGENT|IMMEDIATE|CRITICAL|PRIORITY|MORNING|EVENING|DAILY)/i,
  /complete.*overdue/i, /complete.*follow.?ups/i, /handle.*overdue/i,
  /in (next|the next) \d+ (minutes|min|hours|hour)/i,
  /before \d+ (AM|PM|am|pm)/i, /in priority order/i,
];

async function parseAndExecuteActions(supabase: any, response: string, existing: ActionResult[]): Promise<ActionResult[]> {
  const actions = [...existing];
  const re = /\[ACTION:(\w+)([^\]]*)\]/g; let m;
  while ((m = re.exec(response)) !== null) {
    const type = m[1], params: Record<string, string> = {};
    const pr = /(\w+)=\"([^\"]*)\"/g; let pm; while ((pm = pr.exec(m[2])) !== null) params[pm[1]] = pm[2];
    try {
      switch (type) {
        case "CREATE_TASK": {
          if (BLOCKED_TASK_PATTERNS.some(p => p.test(params.title || ""))) { actions.push({ type: "task_blocked", success: false, title: params.title }); break; }
          const { data, error } = await supabase.from("tasks").insert({ title: params.title, due_date: params.due_date || null, priority: params.priority || "normal", order_id: params.order_id || null, description: params.description || null, assigned_to: params.assigned_to || null, status: "open", created_by: "assistant", task_type: "manual_task", source_type: "manual" }).select("id").single();
          actions.push({ type: "task_created", success: !error, title: params.title, id: data?.id }); break;
        }
        case "COMPLETE_TASK": { const { error } = await supabase.from("tasks").update({ status: "complete", completed_at: new Date().toISOString() }).eq("id", params.task_id); actions.push({ type: "task_completed", success: !error }); break; }
        case "LOG_NOTE": case "ADD_TIMELINE": { const { error } = await supabase.from("order_timeline").insert({ order_id: params.order_id, event_type: params.event_type || "note", title: params.title, description: params.description || "", created_by: "assistant" }); actions.push({ type: "timeline_added", success: !error }); break; }
        case "UPDATE_STATUS": { const { error } = await supabase.from("orders").update({ status: params.new_status }).eq("id", params.order_id); actions.push({ type: "status_updated", success: !error }); break; }
        case "TRIGGER_GMAIL_SCAN": { supabase.functions.invoke("gmail-scan", { body: { max_results: 50 } }).catch(() => {}); actions.push({ type: "gmail_scan_triggered", success: true }); break; }
        case "TRIGGER_DRIVE_SCAN": { supabase.functions.invoke("drive-scan-documents", { body: { order_id: params.order_id } }).catch(() => {}); actions.push({ type: "drive_scan_triggered", success: true }); break; }
        case "TRIGGER_QB_SYNC": { supabase.functions.invoke("qb-check-sync", { body: { order_id: params.order_id } }).catch(() => {}); actions.push({ type: "qb_sync_triggered", success: true }); break; }
      }
    } catch (e: any) { actions.push({ type, success: false, error: e.message }); }
  }
  return actions;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const { message, history } = await req.json();
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return new Response(JSON.stringify({ response: "API key not configured." }), { headers: { ...cors, "Content-Type": "application/json" } });

    const tier = classifyMessage(message);
    console.log(`chat-assistant v13: tier=${tier}`);

    const { snapshot, tasks } = await getOrBuildSnapshot(supabase, tier, message);
    const actions: ActionResult[] = [];
    if (tier !== "simple" && tasks.length > 0) await deduplicateTasks(supabase, tasks, actions);

    const systemPrompt = buildSystemPrompt(tier, snapshot);
    const claudeMessages: any[] = [];
    if (history?.length) { const lim = tier === "simple" ? 2 : 6; for (const h of history.slice(-lim)) claudeMessages.push({ role: h.role, content: h.content }); }
    claudeMessages.push({ role: "user", content: message });

    const aiResp = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: pickModel(tier), max_tokens: pickMaxTokens(tier), system: systemPrompt, messages: claudeMessages }) });
    if (!aiResp.ok) { const t = await aiResp.text(); throw new Error(`Claude API ${aiResp.status}: ${t.substring(0, 200)}`); }

    const aiData = await aiResp.json();
    let response = aiData.content?.map((c: any) => c.text || "").join("") || "Couldn't wrangle a response there, partner.";
    const usage = aiData.usage; if (usage) console.log(`v13 tokens: in=${usage.input_tokens} out=${usage.output_tokens}`);

    let parsedActions = actions;
    if (tier !== "simple") { parsedActions = await parseAndExecuteActions(supabase, response, actions); response = response.replace(/\[ACTION:[^\]]*\]/g, "").trim(); }

    // Background gmail scan to keep inbox fresh
    supabase.functions.invoke("gmail-scan", { body: {} }).catch(() => {});

    return new Response(JSON.stringify({ response, actions: parsedActions }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err: any) {
    console.error(`chat-assistant v13 FATAL: ${err.message}`);
    return new Response(JSON.stringify({ response: `Hit a fence post — ${err.message}. Tell Chandy if this keeps happening.`, error: err.message }), { headers: { ...cors, "Content-Type": "application/json" } });
  }
});
