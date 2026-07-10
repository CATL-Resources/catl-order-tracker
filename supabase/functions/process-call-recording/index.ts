// DO NOT EDIT IN LOVABLE — deployed via Supabase MCP
// Version: 2 (2026-03-31) — Three-way call routing: equipment → CRLE, vet → HerdWork, personal → purge
// Pipeline: BCR uploads audio → Deepgram transcribes → Claude classifies + extracts → routed by type

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-upload-secret",
  "Content-Type": "application/json",
};

function normalizePhone(raw: string): string {
  return (raw || "").replace(/[^0-9]/g, "");
}

function stripCountryCode(digits: string): string {
  if (digits.length === 11 && digits.startsWith("1")) return digits.substring(1);
  return digits;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // CRLE Supabase client (Equipment Manager — primary)
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // =============================================
    // STEP 0: Auth check
    // =============================================
    const uploadSecret = Deno.env.get("CALL_UPLOAD_SECRET");
    const providedSecret = req.headers.get("x-upload-secret");
    if (uploadSecret && providedSecret !== uploadSecret) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 200, headers: corsHeaders });
    }

    // =============================================
    // STEP 1: Receive audio
    // =============================================
    let audioBuffer: ArrayBuffer | null = null;
    let fileName = "call.m4a";
    let phoneNumber = "";
    let direction = "unknown";
    let durationSeconds = 0;
    let callLogId: string | null = null;

    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      const audioFile = formData.get("audio") as File | null;
      if (!audioFile) {
        return new Response(JSON.stringify({ success: false, error: "No audio file in upload" }), { status: 200, headers: corsHeaders });
      }
      audioBuffer = await audioFile.arrayBuffer();
      fileName = audioFile.name || "call.m4a";
      phoneNumber = (formData.get("phone_number") as string) || "";
      direction = (formData.get("direction") as string) || "unknown";
      durationSeconds = parseInt((formData.get("duration") as string) || "0", 10);
    } else {
      const body = await req.json();
      callLogId = body.call_log_id;
      if (!callLogId) {
        return new Response(JSON.stringify({ success: false, error: "call_log_id required for JSON requests" }), { status: 200, headers: corsHeaders });
      }
    }

    // =============================================
    // STEP 2: Store audio and create call_log entry
    // =============================================
    if (audioBuffer && !callLogId) {
      const normalizedPhone = stripCountryCode(normalizePhone(phoneNumber));
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const storagePath = `calls/${timestamp}_${normalizedPhone || "unknown"}_${fileName}`;

      const { error: uploadErr } = await supabase.storage
        .from("call-recordings")
        .upload(storagePath, audioBuffer, { contentType: "audio/mp4", upsert: false });

      if (uploadErr) {
        return new Response(JSON.stringify({ success: false, error: `Upload failed: ${uploadErr.message}` }), { status: 200, headers: corsHeaders });
      }

      const { data: newEntry, error: insertErr } = await supabase
        .from("call_log")
        .insert({
          phone_number: phoneNumber,
          phone_number_normalized: normalizedPhone,
          direction,
          duration_seconds: durationSeconds,
          audio_storage_path: storagePath,
          audio_file_name: fileName,
          audio_file_size_bytes: audioBuffer.byteLength,
          processing_status: "uploaded",
        })
        .select("id")
        .single();

      if (insertErr || !newEntry) {
        return new Response(JSON.stringify({ success: false, error: `DB insert failed: ${insertErr?.message}` }), { status: 200, headers: corsHeaders });
      }

      callLogId = newEntry.id;
    }

    // Load the call_log entry
    const { data: callEntry, error: loadErr } = await supabase
      .from("call_log")
      .select("*")
      .eq("id", callLogId)
      .single();

    if (loadErr || !callEntry) {
      return new Response(JSON.stringify({ success: false, error: "Call log entry not found" }), { status: 200, headers: corsHeaders });
    }

    // =============================================
    // STEP 3: Transcribe with Deepgram
    // =============================================
    let transcript = callEntry.transcript;
    let segments = callEntry.transcript_segments;
    let confidence = callEntry.transcription_confidence;

    if (!transcript) {
      await supabase.from("call_log").update({ processing_status: "transcribing" }).eq("id", callLogId);

      const deepgramKey = Deno.env.get("DEEPGRAM_API_KEY");
      if (!deepgramKey) {
        await supabase.from("call_log").update({ processing_status: "failed", processing_error: "DEEPGRAM_API_KEY not set" }).eq("id", callLogId);
        return new Response(JSON.stringify({ success: false, error: "DEEPGRAM_API_KEY not configured" }), { status: 200, headers: corsHeaders });
      }

      const { data: audioData, error: dlErr } = await supabase.storage
        .from("call-recordings")
        .download(callEntry.audio_storage_path);

      if (dlErr || !audioData) {
        await supabase.from("call_log").update({ processing_status: "failed", processing_error: `Audio download failed: ${dlErr?.message}` }).eq("id", callLogId);
        return new Response(JSON.stringify({ success: false, error: "Audio download failed" }), { status: 200, headers: corsHeaders });
      }

      const audioBytes = await audioData.arrayBuffer();

      const dgResp = await fetch("https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&diarize=true&punctuate=true&utterances=true", {
        method: "POST",
        headers: { "Authorization": `Token ${deepgramKey}`, "Content-Type": "audio/mp4" },
        body: new Uint8Array(audioBytes),
      });

      if (!dgResp.ok) {
        const errText = await dgResp.text();
        await supabase.from("call_log").update({ processing_status: "failed", processing_error: `Deepgram error: ${errText}` }).eq("id", callLogId);
        return new Response(JSON.stringify({ success: false, error: `Deepgram failed: ${errText}` }), { status: 200, headers: corsHeaders });
      }

      const dgResult = await dgResp.json();
      const channel = dgResult.results?.channels?.[0];
      transcript = channel?.alternatives?.[0]?.transcript || "";
      confidence = channel?.alternatives?.[0]?.confidence || 0;
      segments = (dgResult.results?.utterances || []).map((u: any) => ({
        speaker: u.speaker, text: u.transcript, start: u.start, end: u.end, confidence: u.confidence,
      }));

      await supabase.from("call_log").update({
        transcript, transcript_segments: segments, transcription_confidence: confidence,
        processing_status: "transcribed",
      }).eq("id", callLogId);
    }

    // =============================================
    // STEP 4: Classify + Extract with Claude
    // =============================================
    if (!callEntry.ai_summary || callEntry.processing_status === "transcribed") {
      await supabase.from("call_log").update({ processing_status: "extracting" }).eq("id", callLogId);

      const claudeKey = Deno.env.get("ANTHROPIC_API_KEY");
      if (!claudeKey) {
        await supabase.from("call_log").update({ processing_status: "failed", processing_error: "ANTHROPIC_API_KEY not set" }).eq("id", callLogId);
        return new Response(JSON.stringify({ success: false, error: "ANTHROPIC_API_KEY not configured" }), { status: 200, headers: corsHeaders });
      }

      // Updated prompt: classify FIRST, then extract based on type
      const extractionPrompt = `You are processing a phone call transcript for CATL Resources, a business in western South Dakota that has TWO divisions:

1. LIVESTOCK EQUIPMENT SALES — sells Silencer squeeze chutes (Ranch, HD, CP, MAXX, Tilt), Daniels alleys/loading chutes/panels, Rawhide portable processors, MJE/Conquistador wheel corrals and calf tables, LEM/Rupp calf tables, Linn gates/panels/tubs. Common options: Dual Controls, XP Squeeze, Neck Access, Walk-Through Doors, Louvers, Rear Hook-Up, HNB Neck Extender Bars, Yearling Sidegates, Pivot Controls.

2. VETERINARY PRACTICE (CATL Resources PC) — mobile vet practice serving ranching operations. Work includes: BSE (breeding soundness exams), preg checks, herd health, vaccination programs, treatment protocols, breeding projects, synchronization, semen delivery, calving assistance, sale barn vet work.

The employee on the call is Tim Olson.

FIRST, classify this call into one of these categories:
- "equipment" — discussing equipment sales, quotes, orders, freight, delivery, inventory
- "veterinary" — discussing vet work, breeding, BSE, preg checks, herd health, vaccinations, treatments, scheduling cow work
- "personal" — personal conversation, family, non-business topics
- "spam" — telemarketer, robocall, wrong number
- "other" — business-related but doesn't fit equipment or vet

THEN extract relevant information based on the category.

Return ONLY valid JSON with no markdown formatting:
{
  "call_type": "equipment|veterinary|personal|spam|other",
  "confidence": 0.0 to 1.0,
  "customer_name": "string or null",
  "summary": "2-3 sentence plain English summary",
  "equipment_mentioned": ["array — only if equipment call"],
  "vet_topics": ["array — only if vet call, e.g. 'BSE', 'preg check', 'herd health'"],
  "vet_category": "breeding_project|bse|preg_check|herd_health|vaccination|treatment|consultation|scheduling|other — only if vet call",
  "animals_mentioned": ["any specific animals, herds, or counts mentioned — only if vet call"],
  "operation_name": "ranch or operation name if mentioned — only if vet call",
  "commitments": [{"text": "what was promised", "deadline": "date if mentioned or null"}],
  "next_action": "string or null",
  "freight_details": "string or null — only if equipment call",
  "pricing_discussed": {"items": [{"description": "string", "amount": number}], "total": null} ,
  "sentiment": "positive|neutral|negative|urgent"
}

Transcript:
${transcript}`;

      const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": claudeKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1500,
          messages: [{ role: "user", content: extractionPrompt }],
        }),
      });

      if (!claudeResp.ok) {
        const errText = await claudeResp.text();
        await supabase.from("call_log").update({ processing_status: "failed", processing_error: `Claude error: ${errText}` }).eq("id", callLogId);
        return new Response(JSON.stringify({ success: false, error: `Claude failed: ${errText}` }), { status: 200, headers: corsHeaders });
      }

      const claudeResult = await claudeResp.json();
      const rawText = claudeResult.content?.[0]?.text || "{}";

      let extraction: any;
      try {
        extraction = JSON.parse(rawText.replace(/```json|```/g, "").trim());
      } catch {
        await supabase.from("call_log").update({ processing_status: "failed", processing_error: `JSON parse failed: ${rawText.substring(0, 200)}` }).eq("id", callLogId);
        return new Response(JSON.stringify({ success: false, error: "Claude returned invalid JSON" }), { status: 200, headers: corsHeaders });
      }

      const callType = extraction.call_type || "other";

      // =============================================
      // STEP 5: ROUTE based on call_type
      // =============================================

      // ---- PERSONAL / SPAM: Purge ----
      if (callType === "personal" || callType === "spam") {
        // Delete the audio file from storage
        if (callEntry.audio_storage_path) {
          await supabase.storage.from("call-recordings").remove([callEntry.audio_storage_path]);
        }

        // Update call_log with minimal info (no transcript stored for personal calls)
        await supabase.from("call_log").update({
          transcript: null,
          transcript_segments: null,
          ai_summary: `[${callType.toUpperCase()} CALL — purged]`,
          call_sentiment: "neutral",
          processing_status: "complete",
          processing_error: null,
          // Store call_type in a metadata-safe way
          equipment_mentioned: [],
          commitments: [],
          customer_name_detected: null,
          next_action: null,
        }).eq("id", callLogId);

        return new Response(JSON.stringify({
          success: true,
          call_log_id: callLogId,
          call_type: callType,
          action: "purged",
          message: `${callType} call — audio and transcript deleted`,
        }), { status: 200, headers: corsHeaders });
      }

      // ---- VETERINARY: Route to HerdWork ----
      if (callType === "veterinary") {
        // Save to HerdWork's vet_call_log table
        const herdworkUrl = Deno.env.get("HERDWORK_SUPABASE_URL") || "https://irsztvspkjfyzhhfbdet.supabase.co";
        const herdworkKey = Deno.env.get("HERDWORK_SERVICE_ROLE_KEY");

        if (herdworkKey) {
          const herdwork = createClient(herdworkUrl, herdworkKey);

          await herdwork.from("vet_call_log").insert({
            phone_number: callEntry.phone_number,
            phone_number_normalized: callEntry.phone_number_normalized,
            direction: callEntry.direction,
            duration_seconds: callEntry.duration_seconds,
            audio_storage_path: callEntry.audio_storage_path,
            audio_file_name: callEntry.audio_file_name,
            transcript,
            transcript_segments: segments,
            transcription_confidence: confidence,
            ai_summary: extraction.summary || null,
            client_name_detected: extraction.customer_name || null,
            operation_name_detected: extraction.operation_name || null,
            topics: extraction.vet_topics || [],
            animals_mentioned: extraction.animals_mentioned || [],
            commitments: extraction.commitments || [],
            next_action: extraction.next_action || null,
            call_sentiment: extraction.sentiment || "neutral",
            call_category: extraction.vet_category || "other",
            source_call_log_id: callLogId,
            source_project: "crle",
            call_date: callEntry.call_date,
          });
        }

        // Update CRLE call_log — mark as vet call, keep minimal data
        await supabase.from("call_log").update({
          ai_summary: `[VET CALL] ${extraction.summary || ""}`,
          customer_name_detected: extraction.customer_name || null,
          equipment_mentioned: [],
          commitments: extraction.commitments || [],
          next_action: extraction.next_action || null,
          call_sentiment: extraction.sentiment || "neutral",
          processing_status: "complete",
          processing_error: null,
        }).eq("id", callLogId);

        return new Response(JSON.stringify({
          success: true,
          call_log_id: callLogId,
          call_type: "veterinary",
          action: "routed_to_herdwork",
          vet_category: extraction.vet_category,
          summary: extraction.summary,
          herdwork_routed: !!herdworkKey,
        }), { status: 200, headers: corsHeaders });
      }

      // ---- EQUIPMENT (or OTHER): Process in CRLE ----
      // Match customer by phone number
      let customerId: string | null = null;
      let matchMethod: string | null = null;
      let matchConfidence = 0;

      const phoneToMatch = stripCountryCode(callEntry.phone_number_normalized || "");

      if (phoneToMatch && phoneToMatch.length >= 7) {
        const { data: phoneMatch } = await supabase
          .from("customers")
          .select("id, name, phone")
          .filter("phone", "neq", null)
          .limit(500);

        if (phoneMatch) {
          for (const cust of phoneMatch) {
            const custNormalized = stripCountryCode(normalizePhone(cust.phone || ""));
            if (custNormalized === phoneToMatch) {
              customerId = cust.id;
              matchMethod = "phone_number";
              matchConfidence = 0.95;
              break;
            }
          }
        }
      }

      // If no phone match, try Claude's detected name
      if (!customerId && extraction.customer_name) {
        const { data: nameMatch } = await supabase
          .from("customers")
          .select("id, name")
          .ilike("name", `%${extraction.customer_name}%`)
          .limit(5);

        if (nameMatch && nameMatch.length === 1) {
          customerId = nameMatch[0].id;
          matchMethod = "ai_name_match";
          matchConfidence = 0.7;
        } else if (nameMatch && nameMatch.length > 1) {
          matchMethod = "ai_name_ambiguous";
          matchConfidence = 0.3;
        }
      }

      // Save extraction results
      await supabase.from("call_log").update({
        ai_summary: extraction.summary || null,
        customer_name_detected: extraction.customer_name || null,
        equipment_mentioned: extraction.equipment_mentioned || [],
        commitments: extraction.commitments || [],
        next_action: extraction.next_action || null,
        freight_details: extraction.freight_details || null,
        pricing_discussed: extraction.pricing_discussed || null,
        call_sentiment: extraction.sentiment || "neutral",
        customer_id: customerId,
        match_method: matchMethod,
        match_confidence: matchConfidence,
        processing_status: "complete",
        processing_error: null,
      }).eq("id", callLogId);

      // Create order_timeline entry if matched to active order
      if (customerId) {
        const { data: activeOrder } = await supabase
          .from("orders")
          .select("id, contract_name")
          .eq("customer_id", customerId)
          .not("status", "eq", "delivered")
          .order("created_at", { ascending: false })
          .limit(1)
          .single();

        if (activeOrder) {
          const { data: timelineEntry } = await supabase
            .from("order_timeline")
            .insert({
              order_id: activeOrder.id,
              event_type: "phone_call",
              title: `Phone call${extraction.customer_name ? " with " + extraction.customer_name : ""}`,
              description: extraction.summary || "Call recorded and transcribed",
              metadata: {
                call_log_id: callLogId,
                duration_seconds: callEntry.duration_seconds,
                equipment_mentioned: extraction.equipment_mentioned,
                commitments: extraction.commitments,
              },
            })
            .select("id")
            .single();

          if (timelineEntry) {
            await supabase.from("call_log").update({
              order_id: activeOrder.id,
              timeline_entry_id: timelineEntry.id,
            }).eq("id", callLogId);
          }
        }
      }

      return new Response(JSON.stringify({
        success: true,
        call_log_id: callLogId,
        call_type: callType,
        action: "processed_equipment",
        customer_matched: !!customerId,
        customer_name: extraction.customer_name,
        match_method: matchMethod,
        summary: extraction.summary,
        equipment: extraction.equipment_mentioned,
        commitments: extraction.commitments,
        next_action: extraction.next_action,
      }), { status: 200, headers: corsHeaders });
    }

    // Already fully processed
    return new Response(JSON.stringify({
      success: true,
      call_log_id: callLogId,
      message: "Already processed",
      summary: callEntry.ai_summary,
    }), { status: 200, headers: corsHeaders });

  } catch (err: any) {
    console.error("process-call-recording error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message || "Unknown error" }), { status: 200, headers: corsHeaders });
  }
});
