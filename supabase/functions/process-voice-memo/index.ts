// DO NOT EDIT IN LOVABLE — deployed via Supabase MCP
// Version: 4 (2026-04-01) — Process voice memos
// Changed: claude-sonnet → claude-haiku for faster extraction (fixes timeout)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-upload-secret, x-file-name, x-recorded-by, x-source", "Content-Type": "application/json" };
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const uploadSecret = Deno.env.get("CALL_UPLOAD_SECRET");
  const providedSecret = req.headers.get("x-upload-secret") || "";
  if (uploadSecret && providedSecret !== uploadSecret) return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 200, headers: corsHeaders });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const contentType = req.headers.get("content-type") || "";
    let audioBuffer: ArrayBuffer | null = null, fileName = "memo.m4a", recordedBy = "tim", memoId: string | null = null;
    if (contentType.includes("multipart/form-data")) {
      const fd = await req.formData(); const af = fd.get("audio") as File | null;
      if (!af) return new Response(JSON.stringify({ success: false, error: "No audio" }), { status: 200, headers: corsHeaders });
      audioBuffer = await af.arrayBuffer(); fileName = af.name || "memo.m4a"; recordedBy = (fd.get("recorded_by") as string) || "tim";
    } else if (contentType.includes("octet-stream") || contentType.includes("audio/")) {
      audioBuffer = await req.arrayBuffer(); fileName = req.headers.get("x-file-name") || "memo.m4a"; recordedBy = req.headers.get("x-recorded-by") || "tim";
      if (!audioBuffer || audioBuffer.byteLength === 0) return new Response(JSON.stringify({ success: false, error: "Empty body" }), { status: 200, headers: corsHeaders });
    } else if (contentType.includes("application/json")) {
      const body = await req.json(); memoId = body.memo_id;
      if (!memoId) return new Response(JSON.stringify({ success: false, error: "memo_id required" }), { status: 200, headers: corsHeaders });
    } else {
      audioBuffer = await req.arrayBuffer(); fileName = req.headers.get("x-file-name") || "memo.m4a"; recordedBy = req.headers.get("x-recorded-by") || "tim";
      if (!audioBuffer || audioBuffer.byteLength < 100) return new Response(JSON.stringify({ success: false, error: `Unknown content-type` }), { status: 200, headers: corsHeaders });
    }
    if (!memoId && audioBuffer) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const sp = `memos/${ts}_${recordedBy}_${fileName}`;
      const ext = fileName.toLowerCase().split(".").pop();
      const mm: Record<string,string> = { m4a:"audio/mp4",mp3:"audio/mpeg",ogg:"audio/ogg",wav:"audio/wav",amr:"audio/amr","3gp":"audio/3gpp",webm:"audio/webm" };
      const mt = (ext && mm[ext]) || "audio/mp4";
      const { error: ue } = await supabase.storage.from("voice-memos").upload(sp, audioBuffer, { contentType: mt, upsert: false });
      if (ue) return new Response(JSON.stringify({ success: false, error: `Upload: ${ue.message}` }), { status: 200, headers: corsHeaders });
      const { data: nm, error: ie } = await supabase.from("voice_memos").insert({ audio_storage_path: sp, audio_file_name: fileName, audio_file_size_bytes: audioBuffer.byteLength, recorded_by: recordedBy, processing_status: "uploaded" }).select("id").single();
      if (ie || !nm) return new Response(JSON.stringify({ success: false, error: `Insert: ${ie?.message}` }), { status: 200, headers: corsHeaders });
      memoId = nm.id;
    }
    if (!memoId) return new Response(JSON.stringify({ success: false, error: "No memo" }), { status: 200, headers: corsHeaders });
    const { data: memo, error: le } = await supabase.from("voice_memos").select("*").eq("id", memoId).single();
    if (le || !memo) return new Response(JSON.stringify({ success: false, error: "Not found" }), { status: 200, headers: corsHeaders });
    let transcript = memo.transcript;
    if (!transcript) {
      await supabase.from("voice_memos").update({ processing_status: "transcribing" }).eq("id", memoId);
      const dk = Deno.env.get("DEEPGRAM_API_KEY");
      if (!dk) { await supabase.from("voice_memos").update({ processing_status:"failed",processing_error:"DEEPGRAM_API_KEY not set" }).eq("id",memoId); return new Response(JSON.stringify({success:false,error:"No Deepgram key"}),{status:200,headers:corsHeaders}); }
      const { data: ad, error: de } = await supabase.storage.from("voice-memos").download(memo.audio_storage_path);
      if (de || !ad) { await supabase.from("voice_memos").update({processing_status:"failed",processing_error:`DL:${de?.message}`}).eq("id",memoId); return new Response(JSON.stringify({success:false,error:"DL failed"}),{status:200,headers:corsHeaders}); }
      const ab = await ad.arrayBuffer();
      const se = memo.audio_storage_path.toLowerCase().split(".").pop();
      const dmm: Record<string,string> = { m4a:"audio/mp4",mp3:"audio/mpeg",ogg:"audio/ogg",wav:"audio/wav",amr:"audio/amr","3gp":"audio/3gpp",webm:"audio/webm" };
      const dm = (se && dmm[se]) || "audio/mp4";
      const dr = await fetch("https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true",{method:"POST",headers:{"Authorization":`Token ${dk}`,"Content-Type":dm},body:new Uint8Array(ab)});
      if (!dr.ok) { const et=await dr.text(); await supabase.from("voice_memos").update({processing_status:"failed",processing_error:`DG ${dr.status}`}).eq("id",memoId); return new Response(JSON.stringify({success:false,error:"DG failed"}),{status:200,headers:corsHeaders}); }
      const dj = await dr.json(); const ch = dj.results?.channels?.[0];
      transcript = ch?.alternatives?.[0]?.transcript || ""; const conf = ch?.alternatives?.[0]?.confidence || 0; const dur = Math.round(dj.metadata?.duration || 0);
      await supabase.from("voice_memos").update({ transcript, transcription_confidence: conf, duration_seconds: dur, processing_status: "transcribed" }).eq("id", memoId);
    }
    if (!transcript || !transcript.trim()) {
      await supabase.from("voice_memos").update({ processing_status:"complete", ai_summary:"No speech detected", memo_type:"general:empty" }).eq("id",memoId);
      return new Response(JSON.stringify({success:true,memo_id:memoId,summary:"No speech"}),{status:200,headers:corsHeaders});
    }
    if (!memo.ai_summary || memo.processing_status === "transcribed") {
      await supabase.from("voice_memos").update({ processing_status: "extracting" }).eq("id", memoId);
      const ck = Deno.env.get("ANTHROPIC_API_KEY");
      if (!ck) { await supabase.from("voice_memos").update({processing_status:"failed",processing_error:"No Claude key"}).eq("id",memoId); return new Response(JSON.stringify({success:false,error:"No Claude key"}),{status:200,headers:corsHeaders}); }
      const prompt = `You are processing a voice memo from Tim Olson at CATL Resources in western South Dakota.\n\nTim wears multiple hats:\n1. LIVESTOCK EQUIPMENT SALES — squeeze chutes, alleys, panels, processing equipment. Brands: Silencer/Moly, Daniels, Rawhide, MJE/Conquistador, LEM/Rupp, Linn.\n2. VETERINARY CLINIC — CATL Resources PC (vet services, breeding, cattle health).\n3. PERSONAL — ranch work, errands, family, anything else.\n\nClassify and extract. CATEGORIES: "equipment" | "vet" | "general"\n\nReturn ONLY valid JSON:\n{"category":"equipment|vet|general","memo_type":"customer_interaction|task|note|equipment_update|followup|estimate_request|delivery_update|other","summary":"2-3 sentences","customer_name":"string or null","equipment_mentioned":[],"commitments":[{"text":"promised","deadline":"YYYY-MM-DD or null"}],"tasks_to_create":[{"title":"action","description":"context","priority":"urgent|high|normal|low","task_type":"followup|send_estimate|check_order|delivery|paperwork|inventory|customer_service|vet_task|personal|other","due_date":"YYYY-MM-DD or null"}],"sentiment":"positive|neutral|negative|urgent","urgency":"immediate|today|this_week|whenever"}\n\nToday: ${new Date().toISOString().split("T")[0]}\n\nTranscript:\n${transcript}`;
      const cr = await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":ck,"anthropic-version":"2023-06-01"},body:JSON.stringify({model:"claude-haiku-4-5-20251001",max_tokens:1500,messages:[{role:"user",content:prompt}]})});
      if (!cr.ok) { const et=await cr.text(); await supabase.from("voice_memos").update({processing_status:"failed",processing_error:`Claude ${cr.status}: ${et.substring(0,200)}`}).eq("id",memoId); return new Response(JSON.stringify({success:false,error:"Claude failed"}),{status:200,headers:corsHeaders}); }
      const cj = await cr.json(); const rt = cj.content?.[0]?.text || "{}";
      let ex: any;
      try { ex = JSON.parse(rt.replace(/```json|```/g,"").trim()); } catch { await supabase.from("voice_memos").update({processing_status:"failed",processing_error:"Bad JSON"}).eq("id",memoId); return new Response(JSON.stringify({success:false,error:"Bad JSON"}),{status:200,headers:corsHeaders}); }
      const cat = ex.category || "general";
      let cid: string|null = null;
      if (ex.customer_name) { const { data: m } = await supabase.from("customers").select("id,name").ilike("name",`%${ex.customer_name}%`).limit(3); if (m?.length===1) cid=m[0].id; }
      await supabase.from("voice_memos").update({ ai_summary:ex.summary, memo_type:`${cat}:${ex.memo_type||"other"}`, customer_name_detected:ex.customer_name, customer_id:cid, equipment_mentioned:ex.equipment_mentioned||[], commitments:ex.commitments||[], processing_status:"complete", processing_error:null }).eq("id",memoId);
      const tasks=[...(ex.tasks_to_create||[])];
      for (const c of (ex.commitments||[])) { if(c.text) tasks.push({title:c.text,description:`From memo: ${ex.summary||""}`,priority:c.deadline?"high":"normal",task_type:cat==="equipment"?"followup":cat==="vet"?"vet_task":"personal",due_date:c.deadline||null}); }
      if(!tasks.length&&["task","followup"].includes(ex.memo_type)) tasks.push({title:(ex.summary||"Task").substring(0,100),description:transcript,priority:"normal",task_type:cat==="equipment"?"followup":cat==="vet"?"vet_task":"personal"});
      let tc=0; for(const t of tasks){const{error}=await supabase.from("tasks").insert({title:t.title,description:t.description||null,priority:t.priority||"normal",task_type:t.task_type||"other",due_date:t.due_date||null,customer_id:cid,source_type:"voice_memo",source_id:memoId,assigned_to:"tim",created_by:"system"}); if(!error)tc++;}
      if(cat==="vet"){const hk=Deno.env.get("HERDWORK_SERVICE_ROLE_KEY");if(hk){try{const hw=createClient("https://irsztvspkjfyzhhfbdet.supabase.co",hk);await hw.from("vet_call_log").insert({source:"voice_memo",source_memo_id:memoId,transcript,ai_summary:ex.summary,customer_name_detected:ex.customer_name,processing_status:"complete"});}catch{}}}
      return new Response(JSON.stringify({success:true,memo_id:memoId,category:cat,memo_type:ex.memo_type,summary:ex.summary,tasks_created:tc,customer_matched:!!cid,customer_name:ex.customer_name,urgency:ex.urgency}),{status:200,headers:corsHeaders});
    }
    return new Response(JSON.stringify({success:true,memo_id:memoId,message:"Already processed",summary:memo.ai_summary}),{status:200,headers:corsHeaders});
  } catch(e:any) { console.error("Error:",e); return new Response(JSON.stringify({success:false,error:e.message}),{status:200,headers:corsHeaders}); }
});
