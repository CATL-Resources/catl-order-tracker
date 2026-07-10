// gmail-scan v6 — Precise equipment detection: QB estimate approvals always flagged; promo junk blocked; strict cattle equipment keywords only
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

const TIM_EMAILS = ["timselect@gmail.com", "tim@catlresources.com", "chandy@catlresources.com"];
function isTimEmail(email: string): boolean {
  return TIM_EMAILS.some(e => email.toLowerCase().includes(e.toLowerCase()));
}

// ─── EXACT MANUFACTURER DOMAINS ──────────────────────────────────────────────
const MFG_DOMAINS: Record<string, string> = {
  "molymfg.com": "moly",
  "danielsmfg.com": "daniels",
  "rawhidepm.com": "rawhide",
  "linnpost.com": "linn",
  "mjewelding.com": "mje",
};

// ─── OTHER EQUIPMENT VENDORS ─────────────────────────────────────────────────
const EQUIPMENT_VENDOR_DOMAINS = [
  "gallagher", "datamars", "allflex",
  "trutestcorp", "american-scale", "arrowquip",
  "ww-mfg.com", "behlen.com", "priefert.com",
  "powder-river.com", "horsemensheavyhardware",
  "boeingag", "northernlivestock", "sandhillplastics",
];

// ─── QB — special handling, NOT blanket junk ─────────────────────────────────
// These are QB notification emails — subject determines importance
const QB_FROM_PATTERNS = ["quickbooks@", "intuit.com", "notification.intuit", "qbo.intuit"];

// QB subjects that mean something for CATL
const QB_IMPORTANT_SUBJECTS = [
  "estimate", "invoice", "approved", "payment received",
  "purchase order", "bill", "paid", "overdue", "reminder",
  "statement", "receipt",
];

// ─── HARD JUNK PATTERNS ───────────────────────────────────────────────────────
// These domains are NEVER equipment-related — drop entirely
const JUNK_FROM_PATTERNS = [
  // Travel / hospitality
  "marriott", "allegiant.com", "expedia", "airbnb", "hilton", "delta",
  // Golf / sports
  "bushnellgolf", "pgatour", "golftec",
  // Finance / investing (not QB)
  "vanguard", "paypal", "moneyguy", "fidelity", "schwab", "robinhood",
  "investordelivery", "vanguardinvestments",
  // Marketing platforms (bulk senders)
  "em.samsclub", "email.northerntool", "b.email.",
  "cardoneventures", "benziger",
  // Animal health PROMO (not equipment)
  "live-ag.com",       // Merck Animal Health marketing
  "zoetis", "elanco",  // vet pharma promo
  // Livestock news / sales calendars (not equipment orders)
  "angus.org",
  "beehiiv.com",        // CattleUSA newsletter
  "cattleusa.com",      // CattleUSA calendar
  "tsln.com",           // Tri-State Livestock News
  "publiclandscouncil",
  "cowboystatedaily",
  // Auctions (equipment auctions ≠ CATL sales)
  "ascentauctionservices", "purplewave", "ritchie", "ironplanet", "bigironauctions",
  // Aviation
  "foreflight", "aopa.org", "pilotworkshop",
  // Guns / NRA
  "nrapublications", "nra.org", "tactical",
  // Banks / misc
  "wypinnbank", "pinnbank",
  // Food
  "mackenzieriverpizza", "pizzahut", "dominos", "loyalt@",
  // Google system
  "calendar-notification@google",
  // Membership / social
  "alignable", "linkedin",
];

// ─── STRONG KEYWORDS: any single match = equipment email ─────────────────────
// These are specific enough that false positives are nearly impossible
const STRONG_KEYWORDS = [
  // Core product names — CATL sells these
  "silencer",
  "squeeze chute", "squeeze-chute", "squeeze chutes",
  "head gate", "headgate", "head-gate",
  "loading chute", "loading alley", "working alley",
  "sweep tub", "crowding tub",
  "portable corral", "wheel corral",
  "calf table", "tilt table", "calf tip", "calf-table",
  "portable processor",
  // Brands Tim sells
  "moly mfg", "daniels mfg", "rawhide portable", "linn post", "mje welding",
  // Specific options / accessories
  "hydraulic chute", "hydraulic squeeze", "hyd squeeze",
  "eid reader", "rfid reader", "ear tag reader", "alley reader",
  "livestock scale", "cattle scale", "weigh chute",
  "rubber mat", "livestock mat", "floor mat",
  "hydraulic hose", "hyd hose",
  "neck extender", "neckbar", "neck bar",
  "walk-thru door", "walk thru door", "walkthrough door",
  "chest bar", "rear hookup", "dual control",
  // CATL brand itself
  "catl resources", "catlresources",
  // Specific order/invoice patterns
  "catl0", // Moly order number format like CATL0414021626
];

// ─── MEDIUM KEYWORDS: need 2+ or combo to be equipment ───────────────────────
// These words appear in non-equipment contexts too
const MEDIUM_KEYWORDS = [
  // Specific equipment types (less common words)
  "alleyway", "alleyways",
  "corral panels", "corral system",
  "crowding system",
  "scales", // cattle scales specifically
  "hydraulics",
  "cattle mat", "cattle mats",
  "cattle hose",
  "preg check", "pregnancy check",
  "branding chute", "working chute",
  "working cattle", "processing cattle",
  "feedlot equipment",
  // Order language
  "purchase order", "p.o. #", "po #",
  "order confirmation", "order status", "order number",
  "quote request", "spec sheet", "price sheet",
  "freight invoice", "delivery confirmation",
];

// Words that ALONE should NOT flag (too broad — they appear in junk too)
// "cattle", "ranch", "livestock", "corral", "hose", "scale", "panel", "gate"
// These only count when combined with equipment-specific context

function isJunk(fromEmail: string, fromName: string): boolean {
  const lower = (fromEmail + " " + fromName).toLowerCase();
  return JUNK_FROM_PATTERNS.some(p => lower.includes(p));
}

function isMfgDomain(fromEmail: string): { isMfg: boolean; brand: string } {
  const lower = fromEmail.toLowerCase();
  for (const [domain, brand] of Object.entries(MFG_DOMAINS)) {
    if (lower.includes(domain)) return { isMfg: true, brand };
  }
  return { isMfg: false, brand: "" };
}

function isEquipmentVendor(fromEmail: string): boolean {
  const lower = fromEmail.toLowerCase();
  return EQUIPMENT_VENDOR_DOMAINS.some(d => lower.includes(d));
}

function isQBSender(fromEmail: string): boolean {
  return QB_FROM_PATTERNS.some(p => fromEmail.toLowerCase().includes(p));
}

function isQBImportant(subject: string): boolean {
  const lower = subject.toLowerCase();
  return QB_IMPORTANT_SUBJECTS.some(k => lower.includes(k));
}

function categorizeEmail(fromEmail: string, fromName: string, subject: string, snippet: string, toEmail: string): {
  category: string;
  contractNum: string | null;
  isEquipment: boolean;
  matchedKeywords: string[];
} {
  const bodyLower = (subject + " " + snippet).toLowerCase();

  // Extract Moly 5-digit contract numbers (44xxx pattern)
  let contractNum: string | null = null;
  const contractMatch = (subject + " " + snippet).match(/(?:^|[^0-9])(4[0-9]{4})(?:[^0-9]|$)/);
  if (contractMatch) contractNum = contractMatch[1];

  // ── 1. Exact manufacturer domains — always relevant ──
  const { isMfg, brand } = isMfgDomain(fromEmail);
  if (isMfg) {
    const subLower = subject.toLowerCase();
    let cat = brand + "_other";
    if (brand === "moly") {
      if (fromEmail.includes("orders@")) cat = "moly_sales_order";
      else if (fromEmail.includes("donotreply@") || subLower.includes("invoice")) cat = "moly_invoice";
    }
    return { category: cat, contractNum, isEquipment: true, matchedKeywords: [brand] };
  }

  // ── 2. QB notifications — subject determines importance ──
  if (isQBSender(fromEmail)) {
    if (isQBImportant(subject)) {
      return { category: "quickbooks", contractNum, isEquipment: true, matchedKeywords: ["quickbooks", subject.substring(0, 30)] };
    }
    // QB connection requests, marketing etc — junk
    return { category: "junk", contractNum: null, isEquipment: false, matchedKeywords: [] };
  }

  // ── 3. Hard junk — drop immediately ──
  if (isJunk(fromEmail, fromName)) {
    return { category: "junk", contractNum: null, isEquipment: false, matchedKeywords: [] };
  }

  // ── 4. Other known equipment vendors ──
  if (isEquipmentVendor(fromEmail)) {
    return { category: "equipment_vendor", contractNum, isEquipment: true, matchedKeywords: ["vendor"] };
  }

  // ── 5. Contract number in subject/snippet = equipment ──
  if (contractNum) {
    return { category: "equipment", contractNum, isEquipment: true, matchedKeywords: ["contract_" + contractNum] };
  }

  // ── 6. Strong keyword match ──
  const strongMatches = STRONG_KEYWORDS.filter(k => bodyLower.includes(k));
  if (strongMatches.length > 0) {
    return { category: "equipment", contractNum, isEquipment: true, matchedKeywords: strongMatches.slice(0, 3) };
  }

  // ── 7. Medium keyword match ──
  const mediumMatches = MEDIUM_KEYWORDS.filter(k => bodyLower.includes(k));

  // Tim sending email — even 1 medium match is probably business
  if (isTimEmail(fromEmail) && mediumMatches.length >= 1) {
    return { category: "equipment", contractNum, isEquipment: true, matchedKeywords: mediumMatches.slice(0, 3) };
  }

  // Inbound — need 2+ medium matches
  if (mediumMatches.length >= 2) {
    return { category: "equipment", contractNum, isEquipment: true, matchedKeywords: mediumMatches.slice(0, 3) };
  }

  // ── 8. CATL domain ──
  if (fromEmail.includes("catlresources.com") || toEmail.includes("catlresources.com")) {
    return { category: "catl_business", contractNum, isEquipment: true, matchedKeywords: ["catl_domain"] };
  }

  // ── 9. Everything else: store but not equipment ──
  return { category: "other", contractNum: null, isEquipment: false, matchedKeywords: [] };
}

function findAttachmentNames(parts: any[]): string[] {
  const names: string[] = [];
  for (const part of (parts || [])) {
    if (part.filename && part.filename.length > 0) names.push(part.filename);
    if (part.parts) names.push(...findAttachmentNames(part.parts));
  }
  return names;
}

async function resolveCustomerId(supabase: any, fromEmail: string, toEmail: string, matchedOrderId: string | null): Promise<string | null> {
  if (isTimEmail(fromEmail)) {
    if (toEmail) {
      const toAddresses = toEmail.split(/[,;]/).map((a: string) => a.trim().toLowerCase()).filter(Boolean);
      for (const addr of toAddresses) {
        if (isTimEmail(addr)) continue;
        const { data } = await supabase.from("customers").select("id").ilike("email", addr).limit(1);
        if (data?.length) return data[0].id;
      }
    }
  } else {
    const { data } = await supabase.from("customers").select("id").ilike("email", fromEmail).limit(1);
    if (data?.length) return data[0].id;
  }
  if (matchedOrderId) {
    const { data } = await supabase.from("orders").select("customer_id").eq("id", matchedOrderId).single();
    if (data?.customer_id) return data.customer_id;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const maxResults = body.max_results || 30;
    const query = body.query || "newer_than:2d";
    const backfillExisting = body.backfill === true;

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const googleToken = await getGoogleToken(supabase);

    // Backfill mode — re-run categorization on all stored emails
    if (backfillExisting) {
      const { data: allEmails } = await supabase
        .from("gmail_inbox")
        .select("id, from_email, from_name, to_email, subject, snippet, ai_category, is_equipment_related");

      let reclassified = 0;
      for (const email of (allEmails || [])) {
        const { category, contractNum, isEquipment, matchedKeywords } = categorizeEmail(
          email.from_email || "", email.from_name || "", email.subject || "", email.snippet || "", email.to_email || ""
        );
        if (isEquipment !== email.is_equipment_related || category !== email.ai_category) {
          await supabase.from("gmail_inbox").update({
            ai_category: category,
            is_equipment_related: isEquipment,
            matched_contract_number: contractNum,
          }).eq("id", email.id);
          reclassified++;
        }
      }
      return new Response(JSON.stringify({ success: true, mode: "backfill", total: (allEmails || []).length, reclassified }), { status: 200, headers: corsHeaders });
    }

    // Normal scan
    const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}&q=${encodeURIComponent(query)}`;
    const listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${googleToken}` } });
    if (!listResp.ok) throw new Error(`Gmail list failed: ${listResp.status}`);
    const listData = await listResp.json();
    const messageIds = (listData.messages || []).map((m: any) => m.id);
    if (messageIds.length === 0) return new Response(JSON.stringify({ success: true, scanned: 0, new_messages: 0 }), { status: 200, headers: corsHeaders });

    const { data: existing } = await supabase.from("gmail_inbox").select("gmail_message_id").in("gmail_message_id", messageIds);
    const existingIds = new Set((existing || []).map((e: any) => e.gmail_message_id));
    const newIds = messageIds.filter((id: string) => !existingIds.has(id));

    let inserted = 0;
    let junkDropped = 0;
    let customerLinked = 0;
    let equipmentFlagged = 0;

    for (const msgId of newIds.slice(0, 20)) {
      try {
        const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`;
        const msgResp = await fetch(msgUrl, { headers: { Authorization: `Bearer ${googleToken}` } });
        if (!msgResp.ok) continue;
        const msg = await msgResp.json();

        const headers: Record<string, string> = {};
        for (const h of (msg.payload?.headers || [])) headers[h.name.toLowerCase()] = h.value;

        const fromRaw = headers["from"] || "";
        const fromMatch = fromRaw.match(/"?([^"<]*)"?\s*<?([^>]*)>?/);
        const fromName = (fromMatch?.[1] || "").trim();
        const fromEmail = (fromMatch?.[2] || fromRaw).trim().toLowerCase();
        const toEmail = headers["to"] || "";

        const attachmentNames = findAttachmentNames(msg.payload?.parts || []);
        if (msg.payload?.filename && msg.payload.filename.length > 0) attachmentNames.push(msg.payload.filename);

        const { category, contractNum, isEquipment, matchedKeywords } = categorizeEmail(
          fromEmail, fromName, headers["subject"] || "", msg.snippet || "", toEmail
        );

        // Drop hard junk — don't store at all
        if (category === "junk") { junkDropped++; continue; }

        let matchedOrderId: string | null = null;
        if (contractNum) {
          const { data: orderMatch } = await supabase.from("orders").select("id").eq("moly_contract_number", contractNum).limit(1);
          if (orderMatch?.length) matchedOrderId = orderMatch[0].id;
        }

        const customerId = await resolveCustomerId(supabase, fromEmail, toEmail, matchedOrderId);
        if (customerId) customerLinked++;
        if (isEquipment) equipmentFlagged++;

        const receivedAt = msg.internalDate ? new Date(parseInt(msg.internalDate)).toISOString() : null;

        await supabase.from("gmail_inbox").insert({
          gmail_message_id: msgId,
          gmail_thread_id: msg.threadId,
          from_email: fromEmail,
          from_name: fromName,
          to_email: toEmail,
          subject: headers["subject"] || "(no subject)",
          snippet: msg.snippet || "",
          has_attachment: attachmentNames.length > 0,
          attachment_names: attachmentNames,
          labels: msg.labelIds || [],
          received_at: receivedAt,
          is_equipment_related: isEquipment,
          matched_order_id: matchedOrderId,
          matched_contract_number: contractNum,
          ai_category: category,
          customer_id: customerId,
          processed: false,
        });
        inserted++;
      } catch (msgErr: any) {
        console.error(`Error processing message ${msgId}:`, msgErr.message);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      scanned: messageIds.length,
      already_stored: existingIds.size,
      new_messages: inserted,
      junk_dropped: junkDropped,
      equipment_flagged: equipmentFlagged,
      customer_linked: customerLinked,
    }), { status: 200, headers: corsHeaders });
  } catch (err: any) {
    console.error("gmail-scan v6 error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 200, headers: corsHeaders });
  }
});
