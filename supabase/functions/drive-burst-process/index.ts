// drive-burst-process v2 — Process Drive voice memo/call backlog in parallel batches.
// v2: Marks ledger BEFORE attempting call_log insert so duplicate-constraint failures don't
// cause the function to repeatedly hit the same files. Pre-checks audio_file_name+duration
// against existing call_log rows to avoid wasting Deepgram + Claude API calls on dupes.
//
// Modes:
//   POST {} -> process up to 10 new files this invocation
//   POST {"limit": 25} -> process up to 25 (max 50)
//   POST {"folder_id": "<gdrive-folder-id>"} -> only process files in that folder
//
// Returns: { success, total_in_drive, new_found, processed, succeeded, failed, results: [...] }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

function parseContactFromFilename(filename: string): { contactName: string | null; isCallRecording: boolean } {
  const m = filename.match(/^Call recording\s+(.+?)_(\d{6})_(\d{6})\./);
  if (!m) return { contactName: null, isCallRecording: filename.toLowerCase().startsWith("call recording") };
  const rawName = m[1].trim();
  const parts = rawName.split(/\s+/);
  if (parts.length >= 2 && rawName === rawName.toUpperCase()) {
    const first = parts.slice(1).map(p => p.charAt(0) + p.slice(1).toLowerCase()).join(" ");
    const last = parts[0].charAt(0) + parts[0].slice(1).toLowerCase();
    return { contactName: `${first} ${last}`, isCallRecording: true };
  }
  return { contactName: rawName, isCallRecording: true };
}

function parseCubeAcrFilename(filename: string): { contactName: string | null } {
  const m = filename.match(/\d{2}-\d{2}-\d{2}\s+\(phone\)\s+(.+?)\s+\(\+?[\d\s()-]+\)/);
  if (m) {
    const name = m[1].trim();
    if (name === "Unknown contact") return { contactName: null };
    if (/^[\d\s()+-]+$/.test(name)) return { contactName: null };
    return { contactName: name };
  }
  return { contactName: null };
}

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
  if (new Date(tokenRow.access_token_expires_at) > new Date(Date.now() + 5 * 60 * 1000)) return tokenRow.access_token;
  const cid = Deno.env.get("GOOGLE_CLIENT_ID"), cs = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!cid || !cs) throw new Error("GOOGLE_CLIENT_ID/SECRET not set");
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cid, client_secret: cs,
      refresh_token: tokenRow.refresh_token, grant_type: "refresh_token",
    }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  await supabase.from("google_tokens").update({
    access_token: data.access_token,
    access_token_expires_at: new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", tokenRow.id);
  return data.access_token;
}

async function driveSearch(token: string, query: string, pageSize = 1000): Promise<any[]> {
  let allFiles: any[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", query);
    url.searchParams.set("fields", "files(id,name,mimeType,size,createdTime,parents),nextPageToken");
    url.searchParams.set("pageSize", String(pageSize));
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) break;
    const d = await r.json();
    allFiles = allFiles.concat(d.files || []);
    pageToken = d.nextPageToken;
  } while (pageToken);
  return allFiles;
}

async function driveGetSubfolders(token: string, parentId: string): Promise<any[]> {
  return driveSearch(token, `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
}

async function driveGetAllFilesInFolder(token: string, folderId: string): Promise<any[]> {
  return driveSearch(token, `'${folderId}' in parents and trashed=false and mimeType != 'application/vnd.google-apps.folder'`);
}

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
    method: "POST",
    headers: { Authorization: `Token ${dk}`, "Content-Type": mimeType },
    body: new Uint8Array(audioBytes),
  });
  if (!resp.ok) throw new Error(`Deepgram ${resp.status}: ${await resp.text()}`);
  const r = await resp.json();
  const ch = r.results?.channels?.[0];
  return {
    transcript: ch?.alternatives?.[0]?.transcript || "",
    confidence: ch?.alternatives?.[0]?.confidence || 0,
    duration: Math.round(r.metadata?.duration || 0),
  };
}

async function extractWithClaude(transcript: string, isCall: boolean, contactName: string | null): Promise<any> {
  const ck = Deno.env.get("ANTHROPIC_API_KEY");
  if (!ck) throw new Error("ANTHROPIC_API_KEY not set");
  const contactCtx = contactName && isCall
    ? `\nIMPORTANT: The other person on this call is **${contactName}**. Tim Olson is the CATL salesman/vet — he is NOT the customer. Set customer_name to "${contactName}".`
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
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ck, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!resp.ok) throw new Error(`Claude ${resp.status}: ${await resp.text()}`);
  const r = await resp.json();
  const raw = r.content?.[0]?.text || "{}";
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

function getSourceApp(fileName: string, folderName: string): string {
  if (folderName.toLowerCase().includes("cube")) return "cube_acr";
  if (fileName.toLowerCase().startsWith("call recording")) return "samsung_call_recorder";
  if (folderName.toLowerCase().includes("samsung")) return "samsung_voice_recorder";
  return "easy_voice_recorder";
}

async function markLedger(supabase: any, fileId: string, fileName: string, memoId: string | null = null) {
  await supabase.from("processed_drive_files").upsert(
    { drive_file_id: fileId, file_name: fileName, memo_id: memoId },
    { onConflict: "drive_file_id" }
  );
}

async function processOneFile(supabase: any, accessToken: string, file: any, sourceFolder: string, isFolderCall: boolean): Promise<any> {
  const fr: any = { file: file.name, source_folder: sourceFolder, drive_file_id: file.id };
  try {
    if (shouldSkipFile(file.name)) {
      await markLedger(supabase, file.id, file.name);
      fr.skipped = true; fr.reason = "non-audio"; return fr;
    }

    const parsed = parseContactFromFilename(file.name);
    const isCubeAcr = sourceFolder.toLowerCase().includes("cube");
    const contactName = parsed.contactName || (isCubeAcr ? parseCubeAcrFilename(file.name).contactName : null);
    const isCallRecording = isFolderCall || parsed.isCallRecording;
    fr.is_call = isCallRecording;
    fr.parsed_contact = contactName;

    // Pre-check: is there already a call_log row with this exact filename?
    // If so, mark ledger and skip (avoid wasting Deepgram + Claude tokens).
    if (isCallRecording) {
      const { data: existing } = await supabase.from("call_log").select("id").eq("audio_file_name", file.name).limit(1);
      if (existing && existing.length > 0) {
        await markLedger(supabase, file.id, file.name);
        fr.skipped = true; fr.reason = "duplicate_audio_filename"; return fr;
      }
    }

    const dl = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!dl.ok) {
      await markLedger(supabase, file.id, file.name);
      fr.error = `DL ${dl.status}`; return fr;
    }
    const ab = await dl.arrayBuffer();
    const rb = file.name.toLowerCase().includes("chandy") ? "chandy" : "tim";
    const ext = file.name.toLowerCase().split(".").pop() || "amr";
    const mm: Record<string, string> = {
      m4a: "audio/mp4", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
      amr: "audio/amr", webm: "audio/webm", aac: "audio/aac", flac: "audio/flac",
    };
    const mt = mm[ext] || "audio/amr";
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const prefix = isCallRecording ? "calls" : "memos";
    const safeName = sanitizeStoragePath(file.name);
    const sp = `${prefix}/${ts}_${rb}_${safeName}`;
    const srcApp = getSourceApp(file.name, sourceFolder);

    const { error: ue } = await supabase.storage.from("voice-memos").upload(sp, ab, { contentType: mt, upsert: false });
    if (ue) {
      await markLedger(supabase, file.id, file.name);
      fr.error = `Upload: ${ue.message}`;
      return fr;
    }

    let transcript = "", confidence = 0, duration = 0;
    try {
      const r = await transcribeWithDeepgram(ab, mt);
      transcript = r.transcript; confidence = r.confidence; duration = r.duration;
    } catch (e: any) {
      await markLedger(supabase, file.id, file.name);
      fr.error = `Deepgram: ${e.message}`;
      return fr;
    }
    fr.duration = duration;
    const routeToCallLog = isCallRecording || duration > 90;
    fr.routed_to = routeToCallLog ? "call_log" : "voice_memos";

    if (routeToCallLog) {
      // Try to insert into call_log; the unique constraint may reject if a parallel batch
      // beat us to it. In that case, mark the ledger and exit cleanly.
      const { data: callRow, error: ie } = await supabase.from("call_log").insert({
        audio_storage_path: sp, audio_file_name: file.name, audio_file_size_bytes: ab.byteLength,
        duration_seconds: duration, transcript: transcript || null, transcription_confidence: confidence,
        processing_status: transcript ? "transcribed" : "complete",
        call_date: file.createdTime || new Date().toISOString(),
      }).select("id").single();

      if (ie) {
        // If duplicate constraint, that's fine — another worker beat us. Mark ledger and move on.
        await markLedger(supabase, file.id, file.name);
        const isDupe = (ie.message || "").includes("call_log_audio_unique") || (ie.code === "23505");
        fr.skipped = isDupe; fr.error = isDupe ? undefined : `Insert call_log: ${ie.message}`;
        if (isDupe) fr.reason = "race_dupe";
        return fr;
      }
      if (!callRow) {
        await markLedger(supabase, file.id, file.name);
        fr.error = "No call_log row returned";
        return fr;
      }
      fr.call_id = callRow.id;

      if (!transcript) {
        await markLedger(supabase, file.id, file.name);
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

      await markLedger(supabase, file.id, file.name, null);
      fr.success = true; fr.summary = ex.summary; fr.customer = detectedName;
    } else {
      const { data: memo, error: ie } = await supabase.from("voice_memos").insert({
        audio_storage_path: sp, audio_file_name: file.name, audio_file_size_bytes: ab.byteLength,
        duration_seconds: duration, transcript: transcript || null, transcription_confidence: confidence,
        recorded_by: rb, processing_status: transcript ? "transcribed" : "complete",
        drive_file_id: file.id, source_app: srcApp,
        ...(transcript ? {} : { ai_summary: "No speech", memo_type: "general:empty" }),
      }).select("id").single();
      if (ie || !memo) {
        await markLedger(supabase, file.id, file.name);
        fr.error = `Insert voice_memo: ${ie?.message}`;
        return fr;
      }
      fr.memo_id = memo.id;
      await markLedger(supabase, file.id, file.name, memo.id);

      if (!transcript) { fr.summary = "No speech"; fr.success = true; return fr; }

      const ex = await extractWithClaude(transcript, false, null);
      const cat = ex.category || "general";
      const customer = await matchCustomer(supabase, ex.customer_name);
      await supabase.from("voice_memos").update({
        ai_summary: ex.summary,
        memo_type: `${cat}:${ex.memo_type || "other"}`,
        customer_name_detected: customer?.name || ex.customer_name,
        customer_id: customer?.id || null,
        equipment_mentioned: ex.equipment_mentioned || [],
        commitments: ex.commitments || [],
        processing_status: "complete",
      }).eq("id", memo.id);
      fr.success = true; fr.summary = ex.summary;
    }
  } catch (e: any) {
    // Catch-all — ALWAYS mark ledger so we don't infinitely retry the same broken file
    await markLedger(supabase, file.id, file.name);
    fr.error = e.message;
  }
  return fr;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    let limit = 10;
    let explicitFolderId = "";
    try {
      if (req.headers.get("content-type")?.includes("json")) {
        const b = await req.json();
        if (Number.isFinite(b.limit)) limit = Math.max(1, Math.min(50, b.limit));
        explicitFolderId = b.folder_id || "";
      }
    } catch {}

    const { data: tokenRow } = await supabase.from("google_tokens").select("*").limit(1).single();
    if (!tokenRow) {
      return new Response(JSON.stringify({ success: false, error: "No Google token in google_tokens table" }), { status: 200, headers: cors });
    }
    let accessToken: string;
    try {
      accessToken = await refreshGoogleToken(supabase, tokenRow);
    } catch (e: any) {
      return new Response(JSON.stringify({
        success: false,
        error: `OAuth refresh failed: ${e.message}. User must re-auth via Settings → Google Drive & Gmail.`,
      }), { status: 200, headers: cors });
    }

    // Build folder list
    const folders: { id: string; name: string; isCall: boolean }[] = [];
    if (explicitFolderId) {
      folders.push({ id: explicitFolderId, name: "explicit", isCall: true });
    } else {
      const cubeRoot = "1Vr__KIkl4EtXYCNvd92qnyNaLkc5N5DZ";
      const cubeSubs = await driveGetSubfolders(accessToken, cubeRoot);
      for (const sub of cubeSubs) {
        folders.push({ id: sub.id, name: `Cube ACR/${sub.name}`, isCall: true });
      }
      folders.push({ id: cubeRoot, name: "Cube ACR", isCall: true });
    }

    // Gather all candidate files across all folders
    const allFiles: { file: any; sourceFolder: string; isCall: boolean }[] = [];
    for (const folder of folders) {
      const files = await driveGetAllFilesInFolder(accessToken, folder.id);
      for (const f of files) {
        allFiles.push({ file: f, sourceFolder: folder.name, isCall: folder.isCall });
      }
    }

    if (!allFiles.length) {
      return new Response(JSON.stringify({
        success: true, message: "No files in any folder",
        folders_scanned: folders.map(f => f.name), processed: 0,
      }), { status: 200, headers: cors });
    }

    // Filter out already-processed files (via ledger AND voice_memos.drive_file_id)
    const allIds = allFiles.map(f => f.file.id);
    const doneIds = new Set<string>();
    for (let i = 0; i < allIds.length; i += 200) {
      const chunk = allIds.slice(i, i + 200);
      const { data: ledger } = await supabase.from("processed_drive_files").select("drive_file_id").in("drive_file_id", chunk);
      const { data: vmExists } = await supabase.from("voice_memos").select("drive_file_id").in("drive_file_id", chunk);
      for (const r of (ledger || [])) doneIds.add(r.drive_file_id);
      for (const r of (vmExists || [])) if (r.drive_file_id) doneIds.add(r.drive_file_id);
    }
    const newFiles = allFiles.filter(f => !doneIds.has(f.file.id));

    if (!newFiles.length) {
      return new Response(JSON.stringify({
        success: true, message: "All files already processed",
        total_in_drive: allFiles.length, new_found: 0, processed: 0,
      }), { status: 200, headers: cors });
    }

    // Process up to `limit` files in parallel
    const batch = newFiles.slice(0, limit);
    const results = await Promise.all(
      batch.map(b => processOneFile(supabase, accessToken, b.file, b.sourceFolder, b.isCall))
    );

    const succeeded = results.filter(r => r.success).length;
    const skipped = results.filter(r => r.skipped).length;
    const failed = results.filter(r => r.error).length;

    return new Response(JSON.stringify({
      success: true,
      total_in_drive: allFiles.length,
      new_found: newFiles.length,
      processed: batch.length,
      succeeded, skipped, failed,
      remaining: newFiles.length - batch.length,
      results,
    }), { status: 200, headers: cors });

  } catch (e: any) {
    return new Response(JSON.stringify({ success: false, error: e.message || String(e) }), { status: 200, headers: cors });
  }
});
