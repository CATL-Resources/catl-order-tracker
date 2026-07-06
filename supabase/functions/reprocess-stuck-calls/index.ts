// reprocess-stuck-calls v1 — Re-run Claude extraction on call_log entries stuck at 'transcribed' or 'extracting'.
// Mirrors reprocess-stuck-memos pattern but delegates to process-call-recording so all routing logic stays in one place.
//
// Modes:
//   POST {} -> process oldest N stuck calls (default N=3)
//   POST {"limit": 50} -> process oldest 50 stuck calls
//   POST {"call_log_id": "<uuid>"} -> reprocess one specific call
//   POST {"all": true} -> process ALL stuck calls (use with care; intended for backlog recovery after OAuth re-auth)
//
// Returns: { success, processed, total, results: [{call_log_id, file, success, action?, summary?, error?}] }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const callLogId: string | undefined = body.call_log_id;
    const all: boolean = body.all === true;
    const limit: number = Number.isFinite(body.limit) ? Math.max(1, Math.min(100, body.limit)) : 3;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Find stuck calls
    let query = supabase
      .from("call_log")
      .select("id, audio_file_name, processing_status, transcript")
      .not("transcript", "is", null);

    if (callLogId) {
      query = query.eq("id", callLogId);
    } else {
      query = query
        .in("processing_status", ["transcribed", "extracting", "uploaded", "transcribing"])
        .order("created_at", { ascending: true });
      if (!all) query = query.limit(limit);
    }

    const { data: calls, error: qErr } = await query;
    if (qErr) {
      return new Response(JSON.stringify({ success: false, error: qErr.message }), { status: 200, headers: corsHeaders });
    }
    if (!calls?.length) {
      return new Response(JSON.stringify({ success: true, message: "No stuck calls found", processed: 0, total: 0, results: [] }), { status: 200, headers: corsHeaders });
    }

    const baseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const uploadSecret = Deno.env.get("CALL_UPLOAD_SECRET") || "";

    const results: any[] = [];
    for (const c of calls) {
      const r: any = { call_log_id: c.id, file: c.audio_file_name };
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${serviceKey}`,
        };
        if (uploadSecret) headers["x-upload-secret"] = uploadSecret;

        const resp = await fetch(`${baseUrl}/functions/v1/process-call-recording`, {
          method: "POST",
          headers,
          body: JSON.stringify({ call_log_id: c.id }),
        });

        const text = await resp.text();
        let json: any;
        try { json = JSON.parse(text); } catch { json = { raw: text.substring(0, 300) }; }

        if (resp.ok && json.success) {
          r.success = true;
          r.action = json.action || null;
          r.call_type = json.call_type || null;
          r.summary = json.summary || null;
          r.customer_matched = !!json.customer_matched;
        } else {
          r.success = false;
          r.error = json.error || `HTTP ${resp.status}`;
        }
      } catch (e: any) {
        r.success = false;
        r.error = e.message || String(e);
      }
      results.push(r);
    }

    const processed = results.filter(r => r.success).length;
    return new Response(JSON.stringify({
      success: true,
      processed,
      total: results.length,
      stuck_remaining_query_hint: all ? null : `there may be more stuck calls; call again or pass {"all": true}`,
      results,
    }), { status: 200, headers: corsHeaders });

  } catch (e: any) {
    console.error("reprocess-stuck-calls error:", e);
    return new Response(JSON.stringify({ success: false, error: e.message || String(e) }), { status: 200, headers: corsHeaders });
  }
});
