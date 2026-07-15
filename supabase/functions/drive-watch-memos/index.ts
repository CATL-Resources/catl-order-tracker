// drive-watch-memos v14 — instrumented + batched (diagnostic build)
// Why: after the Google token was reconnected 2026-07-15, .json sidecars still
// process but .amr audio has produced nothing since 2026-05-06. This build adds
// verbose console logging (scan/dedup/per-file outcome + errors) so the exact
// failing step shows up in the Supabase edge-function logs, and processes a
// small batch per run so a single failing file can't stall the whole queue.
// No processing logic changed — only logging + the one-file→batch loop.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };

function parseContactFromFilename(filename: string): { contactName: string | null; isCallRecording: boolean } {
  const m = filename.match(/^Call recording\s+(.+?)_(\d{6})_(\d{6})\./);
  if (!m) return { contactName: null, isCallRecording: filename.toLowerCase().startsWith("call recording") };
  const rawName = m[1].trim();
  const parts = rawName.split(/\s+/);
  if (parts.length >= 2 && rawName === rawName.toUpperCase()) {
    const first = parts.slice(1).map(p => p.charAt(0) + p.slice(1).toLowerCase()).join(" ");
    const last = parts[0].charAt(0) + parts[0].slice(1).toLowerCase();
    return { contactName: `${first} ${last}`, isCallRecording: true };
  } else if (parts.length >= 2) {
    return { contactName: rawName, isCallRecording: true };
  }
  return { contactName: rawName, isCallRecording: true };
}

// Parse contact name from Cube ACR filename format
// e.g. "2026-04-06 15-23-37 (phone) Paul Bichler (+1 701-226-5861) ↗.amr"
function parseCubeAcrFilename(filename: string): { contactName: string | null } {
  const m = filename.match(/\d{2}-\d{2}-\d{2}\s+(?:\(phone\)\s+)?(.+?)\s+\(\+?[\d\s-]+\)/);
  if (m) return { contactName: m[1].trim() };
  return { contactName: null };
}

// Sanitize filename for Supabase Storage key
function sanitizeStoragePath(path: string): string {
  return path
    .replace(/\s+/g, "_")
    .replace(/[()]/g, "")
    .replace(/\+/g, "plus")
    .replace(/[↗↘→←↑↓]/g, "")
    .replace(/[^\w\-./]/g, "_")
    .replace(/_+/g, "_");
}

async function refreshGoogleToken(supabase: any, tokenRow: any): Promise<string> {
  if (new Date(tokenRow.access_token_expires_at) > new Date()) return tokenRow.access_token;
  const cid = Deno.env.get("GOOGLE_CLIENT_ID"), cs = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!cid || !cs) throw new Error("GOOGLE_CLIENT_ID/SECRET not set");
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cid, client_secret: cs, refresh_token: tokenRow.refresh_token, grant_type: "refresh_token" }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error("Token refresh failed");
  await supabase.from("google_tokens").update({ access_token: data.access_token, access_token_expires_at: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString(), updated_at: new Date().toISOString() }).eq("id", tokenRow.id);
  return data.access_token;
}

async function driveSearch(token: string, query: string): Promise<any[]> {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,size,createdTime,parents)&orderBy=createdTime desc&pageSize=50`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) { console.error("[dwm] driveSearch failed", r.status, query.slice(0, 80)); return []; }
  return (await r.json()).files || [];
}
async function driveGetSubfolders(token: string, parentId: string): Promise<any[]> {
  return driveSearch(token, `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
}
// Standard audio search — used for EVR/Samsung folders
async function driveGetAudioFiles(token: string, folderId: string): Promise<any[]> {
  return driveSearch(token, `'${folderId}' in parents and trashed=false and (mimeType contains 'audio/' or name contains '.m4a' or name contains '.mp3' or name contains '.wav' or name contains '.ogg' or name contains '.amr')`);
}
// v12: Broad search for Cube ACR subfolders — AMR files stored as octet-stream, missed by audio filter
// Gets everything non-folder, then shouldSkipFile handles filtering
async function driveGetAllFilesInFolder(token: string, folderId: string): Promise<any[]> {
  return driveSearch(token, `'${folderId}' in parents and trashed=false and mimeType != 'application/vnd.google-apps.folder'`);
}

// Skip non-audio files (JSON metadata, etc.)
function shouldSkipFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".json")) return true;
  const audioExts = [".m4a", ".mp3", ".wav", ".ogg", ".amr", ".webm", ".aac", ".flac"];
  return !audioExts.some(ext => lower.endsWith(ext));
}

async function transcribeWithDeepgram(audioBytes: ArrayBuffer, mimeType: string): Promise<{ transcript: string; confidence: number; duration: number }> {
  const dk = Deno.env.get("DEEPGRAM_API_KEY");
  if (!dk) throw new Error("DEEPGRAM_API_KEY not set");
  const resp = await fetch("https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true", {
    method: "POST", headers: { Authorization: `Token ${dk}`, "Content-Type": mimeType }, body: new Uint8Array(audioBytes),
  });
  if (!resp.ok) throw new Error(`Deepgram ${resp.status}`);
  const r = await resp.json(); const ch = r.results?.channels?.[0];
  return { transcript: ch?.alternatives?.[0]?.transcript || "", confidence: ch?.alternatives?.[0]?.confidence || 0, duration: Math.round(r.metadata?.duration || 0) };
}

async function extractWithClaude(transcript: string, isCall: boolean, contactName: string | null): Promise<any> {
  const ck = Deno.env.get("ANTHROPIC_API_KEY");
  if (!ck) throw new Error("ANTHROPIC_API_KEY not set");
  const contactCtx = contactName && isCall
    ? `\nIMPORTANT: The other person on this call is **${contactName}**. Tim Olson is the CATL salesman/vet — he is NOT the customer. ${contactName} is the customer or contact. Set customer_name to "${contactName}".`
    : "";
  const callCtx = isCall ? "\nThis is a PHONE CALL RECORDING. Extract customer name, what was discussed, any pricing, equipment mentioned, commitments made, and next actions." : "";
  const prompt = `You are processing a ${isCall ? "phone call recording" : "voice memo"} from Tim Olson at CATL Resources in western South Dakota.

Tim wears multiple hats:
1. LIVESTOCK EQUIPMENT SALES — squeeze chutes, alleys, panels. Brands: Silencer/Moly, Daniels, Rawhide, MJE/Conquistador, LEM/Rupp, Linn.
2. VETERINARY CLINIC — CATL Resources PC.
3. PERSONAL — ranch work, errands, anything else.${callCtx}${contactCtx}

Classify and extract. CATEGORIES: "equipment" | "vet" | "general"

Return ONLY valid JSON:
{"category":"equipment|vet|general","memo_type":"customer_interaction|task|note|equipment_update|followup|estimate_request|delivery_update|other","summary":"2-3 sentences","customer_name":"string or null","equipment_mentioned":[],"commitments":[{"text":"promised","deadline":"YYYY-MM-DD or null"}],"tasks_to_create":[{"title":"action","description":"context","priority":"urgent|high|normal|low","task_type":"followup|send_estimate|check_order|delivery|paperwork|inventory|customer_service|vet_task|personal|other","due_date":"YYYY-MM-DD or null"}],"sentiment":"positive|neutral|negative|urgent","urgency":"immediate|today|this_week|whenever","pricing_discussed":[{"item":"string","amount":"string"}],"freight_details":"string or null"}

Today: ${new Date().toISOString().split("T")[0]}

Transcript:\n${transcript}`;
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ck, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1500, messages: [{ role: "user", content: prompt }] }),
  });
  if (!resp.ok) throw new Error(`Claude ${resp.status}`);
  const r = await resp.json(); const raw = r.content?.[0]?.text || "{}";
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

async function matchCustomer(supabase: any, name: string | null): Promise<{ id: string; name: string } | null> {
  if (!name) return null;
  const { data: exact } = await supabase.from("customers").select("id,name").ilike("name", `%${name}%`).limit(5);
  if (exact?.length === 1) return exact[0];
  const lastName = name.split(/\s+/).pop();
  if (lastName && lastName.length > 2) {
    const { data: last } = await supabase.from("customers").select("id,name").ilike("name", `%${lastName}%`).limit(5);
    if (last?.length === 1) return last[0];
  }
  return null;
}

async function createTasksIfNoneExist(
  supabase: any, sourceId: string, sourceType: string,
  tasks: any[], customerId: string | null, summaryContext: string
): Promise<number> {
  const { count } = await supabase.from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("source_id", sourceId)
    .eq("source_type", sourceType);
  if (count && count > 0) return 0;
  let created = 0;
  for (const t of tasks) {
    const { error } = await supabase.from("tasks").insert({
      title: t.title, description: t.description || null, priority: t.priority || "normal",
      task_type: t.task_type || "other", due_date: t.due_date || null, customer_id: customerId,
      source_type: sourceType, source_id: sourceId, assigned_to: "tim", created_by: "system"
    });
    if (!error) created++;
  }
  return created;
}

function getSourceApp(fileName: string, folderName: string): string {
  if (folderName.toLowerCase().includes("cube")) return "cube_acr";
  if (fileName.toLowerCase().startsWith("call recording")) return "samsung_call_recorder";
  if (folderName.toLowerCase().includes("samsung")) return "samsung_voice_recorder";
  if (folderName.toLowerCase().includes("call")) return "autosync";
  return "easy_voice_recorder";
}

async function processFile(supabase: any, accessToken: string, file: any, sourceFolder: string, isFolderCall: boolean): Promise<any> {
  const fr: any = { file: file.name, source_folder: sourceFolder };
  try {
    // Skip non-audio files — ledger so they're never retried
    if (shouldSkipFile(file.name)) {
      await supabase.from("processed_drive_files").upsert(
        { drive_file_id: file.id, file_name: file.name, memo_id: null },
        { onConflict: "drive_file_id" }
      );
      fr.skipped = true; fr.reason = "non-audio file"; return fr;
    }

    const parsed = parseContactFromFilename(file.name);
    const isCubeAcr = sourceFolder.toLowerCase().includes("cube");
    const contactName = parsed.contactName || (isCubeAcr ? parseCubeAcrFilename(file.name).contactName : null);
    const isCallRecording = isFolderCall || parsed.isCallRecording;
    fr.is_call = isCallRecording;
    fr.parsed_contact = contactName;

    const dl = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!dl.ok) {
      await supabase.from("processed_drive_files").upsert(
        { drive_file_id: file.id, file_name: file.name, memo_id: null },
        { onConflict: "drive_file_id" }
      );
      fr.error = `DL ${dl.status} — skipped permanently`; console.error("[dwm] download failed", file.name, dl.status); return fr;
    }
    const ab = await dl.arrayBuffer();
    const rb = file.name.toLowerCase().includes("chandy") ? "chandy" : "tim";
    const ext = file.name.toLowerCase().split(".").pop() || "m4a";
    const mm: Record<string, string> = { m4a: "audio/mp4", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", amr: "audio/amr", webm: "audio/webm", aac: "audio/aac", flac: "audio/flac" };
    const mt = mm[ext] || "audio/amr"; // default to audio/amr for Cube ACR files
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const prefix = isCallRecording ? "calls" : "memos";
    const safeName = sanitizeStoragePath(file.name);
    const sp = `${prefix}/${ts}_${rb}_${safeName}`;
    const srcApp = getSourceApp(file.name, sourceFolder);

    const { error: ue } = await supabase.storage.from("voice-memos").upload(sp, ab, { contentType: mt, upsert: false });
    if (ue) { fr.error = `Upload: ${ue.message}`; console.error("[dwm] storage upload failed", file.name, ue.message); return fr; }

    const { transcript, confidence, duration } = await transcribeWithDeepgram(ab, mt);
    fr.duration = duration;
    const routeToCallLog = isCallRecording || duration > 90;
    fr.routed_to = routeToCallLog ? "call_log" : "voice_memos";

    if (routeToCallLog) {
      const { data: callRow, error: ie } = await supabase.from("call_log").insert({
        audio_storage_path: sp, audio_file_name: file.name, audio_file_size_bytes: ab.byteLength,
        duration_seconds: duration, transcript: transcript || null, transcription_confidence: confidence,
        processing_status: transcript ? "transcribed" : "complete",
        call_date: file.createdTime || new Date().toISOString(),
      }).select("id").single();
      if (ie || !callRow) { fr.error = `Insert call_log: ${ie?.message}`; console.error("[dwm] call_log insert failed", file.name, ie?.message); return fr; }
      fr.call_id = callRow.id;

      if (!transcript) {
        await supabase.from("voice_memos").insert({
          audio_storage_path: sp, audio_file_name: file.name, audio_file_size_bytes: ab.byteLength,
          duration_seconds: duration, processing_status: "complete", drive_file_id: file.id,
          source_app: srcApp, recorded_by: rb, ai_summary: "No speech detected", memo_type: "general:empty",
        });
        await supabase.from("processed_drive_files").upsert({ drive_file_id: file.id, file_name: file.name, memo_id: null }, { onConflict: "drive_file_id" });
        fr.summary = "No speech"; fr.success = true; return fr;
      }

      const ex = await extractWithClaude(transcript, true, contactName);
      const cat = ex.category || "general";
      const customerName = contactName || ex.customer_name;
      const customer = await matchCustomer(supabase, customerName);
      const cid = customer?.id || null;
      const detectedName = customer?.name || customerName;

      await supabase.from("call_log").update({
        ai_summary: ex.summary, customer_name_detected: detectedName, customer_id: cid,
        equipment_mentioned: ex.equipment_mentioned || [], commitments: ex.commitments || [],
        next_action: ex.tasks_to_create?.[0]?.title || null, call_sentiment: ex.sentiment,
        pricing_discussed: ex.pricing_discussed || [], freight_details: ex.freight_details || null,
        processing_status: "complete",
      }).eq("id", callRow.id);

      const { data: memoRow } = await supabase.from("voice_memos").insert({
        audio_storage_path: sp, audio_file_name: file.name, audio_file_size_bytes: ab.byteLength,
        duration_seconds: duration, transcript, transcription_confidence: confidence,
        processing_status: "complete", drive_file_id: file.id,
        source_app: srcApp, recorded_by: rb,
        ai_summary: ex.summary,
        memo_type: `${cat}:${ex.memo_type || "customer_interaction"}`,
        customer_name_detected: detectedName, customer_id: cid,
        equipment_mentioned: ex.equipment_mentioned || [], commitments: ex.commitments || [],
      }).select("id").single();

      await supabase.from("processed_drive_files").upsert({ drive_file_id: file.id, file_name: file.name, memo_id: memoRow?.id || null }, { onConflict: "drive_file_id" });

      const allTasks = [...(ex.tasks_to_create || [])];
      for (const c of (ex.commitments || [])) {
        if (c.text) allTasks.push({ title: c.text, description: `From call with ${detectedName || "unknown"}: ${ex.summary || ""}`, priority: c.deadline ? "high" : "normal", task_type: "followup", due_date: c.deadline || null });
      }
      const tc = await createTasksIfNoneExist(supabase, callRow.id, "call_recording", allTasks, cid, ex.summary);
      fr.success = true; fr.summary = ex.summary; fr.customer = detectedName; fr.tasks_created = tc;

    } else {
      const { data: memo, error: ie } = await supabase.from("voice_memos").insert({
        audio_storage_path: sp, audio_file_name: file.name, audio_file_size_bytes: ab.byteLength,
        duration_seconds: duration, transcript: transcript || null, transcription_confidence: confidence,
        recorded_by: rb, processing_status: transcript ? "transcribed" : "complete",
        drive_file_id: file.id, source_app: srcApp,
        ...(transcript ? {} : { ai_summary: "No speech", memo_type: "general:empty" }),
      }).select("id, transcript, audio_file_name").single();
      if (ie || !memo) { fr.error = `Insert: ${ie?.message}`; console.error("[dwm] voice_memos insert failed", file.name, ie?.message); return fr; }
      fr.memo_id = memo.id;

      await supabase.from("processed_drive_files").upsert({ drive_file_id: file.id, file_name: file.name, memo_id: memo.id }, { onConflict: "drive_file_id" });

      if (!transcript) { fr.summary = "No speech"; fr.success = true; return fr; }

      const ex = await extractWithClaude(transcript, false, null);
      const cat = ex.category || "general";
      const customer = await matchCustomer(supabase, ex.customer_name);
      const cid = customer?.id || null;
      await supabase.from("voice_memos").update({
        ai_summary: ex.summary, memo_type: `${cat}:${ex.memo_type || "other"}`,
        customer_name_detected: customer?.name || ex.customer_name, customer_id: cid,
        equipment_mentioned: ex.equipment_mentioned || [], commitments: ex.commitments || [],
        processing_status: "complete", processing_error: null,
      }).eq("id", memo.id);

      const allTasks = [...(ex.tasks_to_create || [])];
      for (const c of (ex.commitments || [])) {
        if (c.text) allTasks.push({ title: c.text, description: `From memo: ${ex.summary || ""}`, priority: c.deadline ? "high" : "normal", task_type: cat === "equipment" ? "followup" : "other", due_date: c.deadline || null });
      }
      const tc = await createTasksIfNoneExist(supabase, memo.id, "voice_memo", allTasks, cid, ex.summary);
      fr.success = true; fr.category = cat; fr.summary = ex.summary; fr.tasks_created = tc;
    }
  } catch (e: any) { fr.error = e?.message || String(e); console.error("[dwm] processFile threw", file.name, fr.error); }
  return fr;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const results: any[] = [];
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: stuckMemos } = await supabase.from("voice_memos")
      .select("id, transcript, processing_status, audio_file_name")
      .in("processing_status", ["extracting", "transcribed"])
      .lt("updated_at", fiveMinAgo).not("transcript", "is", null)
      .order("created_at", { ascending: true }).limit(1);
    if (stuckMemos?.length) {
      const memo = stuckMemos[0];
      console.log("[dwm] retry_stuck branch (skips Drive scan this run)", JSON.stringify({ memo_id: memo.id, file: memo.audio_file_name }));
      try {
        await supabase.from("voice_memos").update({ processing_status: "extracting" }).eq("id", memo.id);
        const parsed = parseContactFromFilename(memo.audio_file_name || "");
        const ex = await extractWithClaude(memo.transcript, parsed.isCallRecording, parsed.contactName);
        const cat = ex.category || "general";
        const customerName = parsed.contactName || ex.customer_name;
        const customer = await matchCustomer(supabase, customerName);
        await supabase.from("voice_memos").update({
          ai_summary: ex.summary, memo_type: `${cat}:${ex.memo_type || "other"}`,
          customer_name_detected: customer?.name || customerName, customer_id: customer?.id || null,
          equipment_mentioned: ex.equipment_mentioned || [], commitments: ex.commitments || [],
          processing_status: "complete",
        }).eq("id", memo.id);
        results.push({ memo_id: memo.id, was_stuck: true, success: true, summary: ex.summary, tasks_created: 0 });
      } catch (e: any) {
        await supabase.from("voice_memos").update({ processing_status: "failed", processing_error: e.message }).eq("id", memo.id);
        results.push({ memo_id: memo.id, was_stuck: true, error: e.message });
      }
      return new Response(JSON.stringify({ success: true, mode: "retry_stuck", results }), { status: 200, headers: cors });
    }

    const { data: tokenRow } = await supabase.from("google_tokens").select("*").limit(1).single();
    if (!tokenRow) { console.error("[dwm] no Google token row"); return new Response(JSON.stringify({ success: false, error: "No Google token" }), { status: 200, headers: cors }); }
    const accessToken = await refreshGoogleToken(supabase, tokenRow);

    let explicitFolderId = "";
    try { if (req.headers.get("content-type")?.includes("json")) { const b = await req.json(); explicitFolderId = b.folder_id || ""; } } catch {}

    const folderSearchNames = ["Voice Recordings", "CATL Voice Memos", "Easy Voice Recorder", "Voice Recorder", "Recordings", "Calls", "Cube ACR"];
    const foldersToScan: { id: string; name: string; isCallFolder: boolean }[] = [];

    if (explicitFolderId) {
      foldersToScan.push({ id: explicitFolderId, name: "explicit", isCallFolder: true });
    } else {
      foldersToScan.push({ id: "1Vr__KIkl4EtXYCNvd92qnyNaLkc5N5DZ", name: "Cube ACR", isCallFolder: true });
      for (const name of folderSearchNames) {
        const files = await driveSearch(accessToken, `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
        for (const f of files) {
          if (f.id === "1Vr__KIkl4EtXYCNvd92qnyNaLkc5N5DZ") continue;
          const subs = await driveGetSubfolders(accessToken, f.id);
          if (subs.length > 0) {
            for (const sub of subs) {
              const snl = sub.name.toLowerCase();
              foldersToScan.push({ id: sub.id, name: `${f.name}/${sub.name}`, isCallFolder: snl.includes("call") || snl.includes("phone") || snl.includes("cube") });
            }
          } else {
            foldersToScan.push({ id: f.id, name: f.name, isCallFolder: f.name.toLowerCase().includes("call") || f.name.toLowerCase().includes("cube") });
          }
        }
      }
    }
    if (!foldersToScan.length) { console.error("[dwm] no folders to scan"); return new Response(JSON.stringify({ success: false, error: "No voice/call folders found" }), { status: 200, headers: cors }); }

    const allFiles: { file: any; sourceFolder: string; isCall: boolean }[] = [];
    for (const folder of foldersToScan) {
      // Standard audio search for non-Cube folders
      if (!folder.name.includes("Cube ACR") && !folder.name.includes("explicit")) {
        const audioFiles = await driveGetAudioFiles(accessToken, folder.id);
        for (const af of audioFiles) allFiles.push({ file: af, sourceFolder: folder.name, isCall: folder.isCallFolder });
      }
      // v12: Cube ACR root — recurse into date subfolders with broad file fetch
      if (folder.name === "Cube ACR" || folder.name === "explicit") {
        const dateFolders = await driveGetSubfolders(accessToken, folder.id);
        console.log("[dwm] cube date subfolders found", dateFolders.length, JSON.stringify(dateFolders.slice(0, 5).map((d: any) => d.name)));
        for (const dateFolder of dateFolders) {
          // v12: Use broad search — AMR files stored as octet-stream, missed by audio mime filter
          const subFiles = await driveGetAllFilesInFolder(accessToken, dateFolder.id);
          for (const af of subFiles) allFiles.push({ file: af, sourceFolder: `Cube ACR/${dateFolder.name}`, isCall: true });
        }
        // Also check root of Cube ACR for any files not in subfolders
        const rootFiles = await driveGetAllFilesInFolder(accessToken, folder.id);
        for (const af of rootFiles) allFiles.push({ file: af, sourceFolder: folder.name, isCall: true });
      }
    }

    console.log("[dwm] scan complete", JSON.stringify({ folders_scanned: foldersToScan.length, total_files: allFiles.length, ext_counts: allFiles.reduce((a: any, f: any) => { const e = (f.file.name.split(".").pop() || "?").toLowerCase(); a[e] = (a[e] || 0) + 1; return a; }, {}) }));
    if (!allFiles.length) return new Response(JSON.stringify({ success: true, message: "No audio files", folders_scanned: foldersToScan.map(f => f.name), processed: 0 }), { status: 200, headers: cors });

    const allIds = allFiles.map(f => f.file.id);
    const { data: ledgerRows, error: ledgerErr } = await supabase.from("processed_drive_files").select("drive_file_id").in("drive_file_id", allIds);
    const { data: existById, error: existErr } = await supabase.from("voice_memos").select("drive_file_id").in("drive_file_id", allIds);
    if (ledgerErr) console.error("[dwm] ledger dedup query error", ledgerErr.message);
    if (existErr) console.error("[dwm] voice_memos dedup query error", existErr.message);
    const doneIds = new Set([
      ...(ledgerRows || []).map((e: any) => e.drive_file_id),
      ...(existById || []).map((e: any) => e.drive_file_id),
    ]);
    const newFiles = allFiles.filter(f => !doneIds.has(f.file.id));
    console.log("[dwm] dedup", JSON.stringify({ ledger_rows: ledgerRows?.length ?? null, exist_rows: existById?.length ?? null, done_ids: doneIds.size, new_found: newFiles.length, sample_new: newFiles.slice(0, 8).map((f: any) => f.file.name) }));

    if (!newFiles.length) return new Response(JSON.stringify({ success: true, message: "All processed", folders_scanned: foldersToScan.map(f => f.name), total_files: allFiles.length, processed: 0 }), { status: 200, headers: cors });

    // Process a batch per run (was one file) so a single failing file cannot stall the whole queue.
    const BATCH = 5;
    for (const nf of newFiles.slice(0, BATCH)) {
      const result = await processFile(supabase, accessToken, nf.file, nf.sourceFolder, nf.isCall);
      results.push(result);
      console.log("[dwm] processed", JSON.stringify({ file: nf.file.name, success: !!result.success, skipped: !!result.skipped, routed_to: result.routed_to ?? null, error: result.error ?? null }));
    }

    const finalResp = {
      success: true, folders_scanned: foldersToScan.map(f => f.name),
      total_files: allFiles.length, new_found: newFiles.length, remaining: Math.max(0, newFiles.length - results.length), results,
    };
    console.log("[dwm] response", JSON.stringify({ total_files: finalResp.total_files, new_found: finalResp.new_found, processed: results.length, remaining: finalResp.remaining }));
    return new Response(JSON.stringify(finalResp), { status: 200, headers: cors });
  } catch (e: any) {
    console.error("[dwm] handler threw", e?.message || String(e));
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 200, headers: cors });
  }
});
