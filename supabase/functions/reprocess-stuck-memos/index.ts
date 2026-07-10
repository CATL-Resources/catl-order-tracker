// reprocess-stuck-memos v1 — Re-run Claude extraction on memos stuck at 'transcribed' or 'extracting'
// Can also be called from the app as a "Retry" button
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };

async function extractWithClaude(transcript: string): Promise<any> {
  const ck = Deno.env.get("ANTHROPIC_API_KEY");
  if (!ck) throw new Error("ANTHROPIC_API_KEY not set");
  const prompt = `You are processing a voice memo from Tim Olson at CATL Resources in western South Dakota.

Tim wears multiple hats:
1. LIVESTOCK EQUIPMENT SALES — squeeze chutes, alleys, panels, processing equipment. Brands: Silencer/Moly, Daniels, Rawhide, MJE/Conquistador, LEM/Rupp, Linn.
2. VETERINARY CLINIC — CATL Resources PC (vet services, breeding, cattle health).
3. PERSONAL — ranch work, errands, family, anything else.

Classify and extract. CATEGORIES: "equipment" | "vet" | "general"

Return ONLY valid JSON:
{"category":"equipment|vet|general","memo_type":"customer_interaction|task|note|equipment_update|followup|estimate_request|delivery_update|other","summary":"2-3 sentences","customer_name":"string or null","equipment_mentioned":[],"commitments":[{"text":"promised","deadline":"YYYY-MM-DD or null"}],"tasks_to_create":[{"title":"action","description":"context","priority":"urgent|high|normal|low","task_type":"followup|send_estimate|check_order|delivery|paperwork|inventory|customer_service|vet_task|personal|other","due_date":"YYYY-MM-DD or null"}],"sentiment":"positive|neutral|negative|urgent","urgency":"immediate|today|this_week|whenever"}

Today: ${new Date().toISOString().split("T")[0]}

Transcript:
${transcript}`;
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ck, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1500, messages: [{ role: "user", content: prompt }] }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Claude ${resp.status}: ${errText.substring(0, 200)}`);
  }
  const r = await resp.json();
  const raw = r.content?.[0]?.text || "{}";
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const memoId = body.memo_id; // optional: reprocess a specific memo
    const limit = body.limit || 3; // process up to N memos per call

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Find stuck memos
    let query = supabase.from("voice_memos")
      .select("id, transcript, processing_status, audio_file_name")
      .not("transcript", "is", null);

    if (memoId) {
      query = query.eq("id", memoId);
    } else {
      query = query.in("processing_status", ["transcribed", "extracting"])
        .order("created_at", { ascending: true })
        .limit(limit);
    }

    const { data: memos, error: qErr } = await query;
    if (qErr) return new Response(JSON.stringify({ success: false, error: qErr.message }), { status: 200, headers: corsHeaders });
    if (!memos?.length) return new Response(JSON.stringify({ success: true, message: "No stuck memos found", processed: 0 }), { status: 200, headers: corsHeaders });

    const results: any[] = [];
    for (const memo of memos) {
      const r: any = { memo_id: memo.id, file: memo.audio_file_name };
      try {
        if (!memo.transcript?.trim()) {
          await supabase.from("voice_memos").update({ processing_status: "complete", ai_summary: "No speech detected", memo_type: "general:empty" }).eq("id", memo.id);
          r.success = true; r.summary = "No speech"; results.push(r); continue;
        }

        await supabase.from("voice_memos").update({ processing_status: "extracting" }).eq("id", memo.id);
        const ex = await extractWithClaude(memo.transcript);
        const cat = ex.category || "general";

        let cid: string | null = null;
        if (ex.customer_name) {
          const { data: m } = await supabase.from("customers").select("id,name").ilike("name", `%${ex.customer_name}%`).limit(3);
          if (m?.length === 1) cid = m[0].id;
        }

        await supabase.from("voice_memos").update({
          ai_summary: ex.summary, memo_type: `${cat}:${ex.memo_type || "other"}`,
          customer_name_detected: ex.customer_name, customer_id: cid,
          equipment_mentioned: ex.equipment_mentioned || [], commitments: ex.commitments || [],
          processing_status: "complete", processing_error: null,
        }).eq("id", memo.id);

        // Create tasks
        const tasks = [...(ex.tasks_to_create || [])];
        for (const c of (ex.commitments || [])) {
          if (c.text) tasks.push({ title: c.text, description: `From memo: ${ex.summary || ""}`, priority: c.deadline ? "high" : "normal", task_type: cat === "equipment" ? "followup" : cat === "vet" ? "vet_task" : "personal", due_date: c.deadline || null });
        }
        let tc = 0;
        for (const t of tasks) {
          const { error } = await supabase.from("tasks").insert({ title: t.title, description: t.description || null, priority: t.priority || "normal", task_type: t.task_type || "other", due_date: t.due_date || null, customer_id: cid, source_type: "voice_memo", source_id: memo.id, assigned_to: "tim", created_by: "system" });
          if (!error) tc++;
        }

        r.success = true; r.category = cat; r.summary = ex.summary; r.tasks_created = tc;
      } catch (e: any) {
        await supabase.from("voice_memos").update({ processing_status: "failed", processing_error: e.message }).eq("id", memo.id);
        r.error = e.message;
      }
      results.push(r);
    }

    return new Response(JSON.stringify({ success: true, processed: results.filter(r => r.success).length, total: results.length, results }), { status: 200, headers: corsHeaders });
  } catch (e: any) {
    console.error("reprocess-stuck-memos error:", e);
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 200, headers: corsHeaders });
  }
});
