import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const MOLY_MANUFACTURER_ID = "b5cf513b-c38b-443e-bd13-8b2e79e1ccb6";
const MFG_DOMAINS: Record<string, string> = { "molymfg.com": "MOLY", "danielsmfg.com": "Daniels", "rawhideportablecorral.com": "Rawhide" };

const MOLY_MODEL_MAP: Record<string, { id: string; name: string; short_name: string }> = {
  "heavy duty wide body": { id: "cb6842c3-ebac-4b6c-a78a-8c85b3c7f599", name: "Heavy Duty Wide Body", short_name: "HDWB" },
  "wide body heavy duty": { id: "cb6842c3-ebac-4b6c-a78a-8c85b3c7f599", name: "Heavy Duty Wide Body", short_name: "HDWB" },
  "silencer wb": { id: "cb6842c3-ebac-4b6c-a78a-8c85b3c7f599", name: "Heavy Duty Wide Body", short_name: "HDWB" },
  "heavy duty standard": { id: "368a8c98-cb0b-4012-b6fa-bdf12023af1a", name: "Heavy Duty Standard", short_name: "HD" },
  "silencer hd": { id: "368a8c98-cb0b-4012-b6fa-bdf12023af1a", name: "Heavy Duty Standard", short_name: "HD" },
  "ranch standard": { id: "363f479b-759a-4c73-9702-333ec6e1a1ed", name: "Ranch Standard", short_name: "R" },
  "silencer r": { id: "363f479b-759a-4c73-9702-333ec6e1a1ed", name: "Ranch Standard", short_name: "R" },
  "ranch wide body": { id: "0ed1d2db-297f-436c-a8f1-846b95fdbd75", name: "Ranch Wide Body", short_name: "RWB" },
  "silencer rwb": { id: "0ed1d2db-297f-436c-a8f1-846b95fdbd75", name: "Ranch Wide Body", short_name: "RWB" },
  "commercial pro standard": { id: "d1428e53-de9f-4765-81a4-bb86fdae64d4", name: "Commercial Pro Standard", short_name: "CP" },
  "silencer cp": { id: "d1428e53-de9f-4765-81a4-bb86fdae64d4", name: "Commercial Pro Standard", short_name: "CP" },
  "commercial pro wide body": { id: "7bc4b4f2-1e9c-4c40-8da7-988dc44cf40a", name: "Commercial Pro Wide Body", short_name: "CPW" },
  "silencer cpw": { id: "7bc4b4f2-1e9c-4c40-8da7-988dc44cf40a", name: "Commercial Pro Wide Body", short_name: "CPW" },
  "maxx": { id: "53cc758e-3a48-4517-ab04-cdb1b68a855b", name: "MAXX", short_name: "MX" },
  "silencer maxx": { id: "53cc758e-3a48-4517-ab04-cdb1b68a855b", name: "MAXX", short_name: "MX" },
  "tilt": { id: "322f681f-82c5-4f30-8c13-11b52074a16c", name: "Tilt", short_name: "TILT" },
  "silencer tilt": { id: "322f681f-82c5-4f30-8c13-11b52074a16c", name: "Tilt", short_name: "TILT" },
  "tilt wide body": { id: "d056f802-51f0-49f6-8a2c-52391f2fbd8b", name: "Tilt Wide Body", short_name: "TW" },
  "silencer tw": { id: "d056f802-51f0-49f6-8a2c-52391f2fbd8b", name: "Tilt Wide Body", short_name: "TW" },
};

const ALLOWED_EXTENSIONS = [".pdf",".jpg",".jpeg",".png",".heic",".gif",".tiff",".tif",".xlsx",".xls",".csv",".doc",".docx"];
const ALLOWED_CONTENT_TYPES = ["application/pdf","image/jpeg","image/png","image/heic","image/gif","image/tiff","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/vnd.ms-excel","text/csv","application/msword","application/vnd.openxmlformats-officedocument.wordprocessingml.document"];

function isAllowedFile(fn: string, ct: string): boolean {
  const ln = (fn||"").toLowerCase(), lt = (ct||"").toLowerCase();
  if (ln.endsWith(".eml") || lt==="message/rfc822") return false;
  for (const e of ALLOWED_EXTENSIONS) if (ln.endsWith(e)) return true;
  for (const c of ALLOWED_CONTENT_TYPES) if (lt.includes(c)) return true;
  return false;
}
function sanitizeFilename(f: string): string {
  return f.replace(/[\/\\:*?"<>|]/g,"_").replace(/\s+/g,"_").replace(/_{2,}/g,"_").replace(/^_+|_+$/g,"");
}
function detectDocType(subj: string, fn: string): string {
  const s=(subj||"").toLowerCase(), f=(fn||"").toLowerCase();
  if (s.includes("invoice")||f.includes("invoice")||f.match(/_\d+in_/i)||f.match(/\d+in_/i)) return "moly_invoice";
  if (s.includes("contract")||f.includes("contract")||f.includes("signed")) return "moly_sales_order";
  if (s.includes("sales order")||s.includes(" so ")||f.includes("sales_order")||f.includes("so_")) return "moly_sales_order";
  if (s.includes("confirmation")||s.includes("order confirm")) return "moly_sales_order";
  if (f.includes("web_order")||f.includes("order_form")||f.includes("web order")||f.includes("order form")||f.includes("catl0")) return "moly_sales_order";
  if (f.includes("bol")||f.includes("bill_of_lading")) return "freight_bol";
  if (f.endsWith(".jpg")||f.endsWith(".jpeg")||f.endsWith(".png")||f.endsWith(".heic")) return "photo";
  // Default for PDFs from Moly-related emails: treat as sales order
  if (f.endsWith(".pdf")) return "moly_sales_order";
  return "mfg_email";
}
function docTypeToSlotType(dt: string): string|null {
  if (dt==="moly_sales_order"||dt==="mfg_contract"||dt==="mfg_so_confirmation") return "moly_sales_order";
  if (dt==="moly_invoice"||dt==="mfg_invoice") return "moly_invoice";
  return null;
}
function extractMatchKeywords(text: string): string[] {
  const kw: string[]=[];
  const five=text.match(/\b(4\d{4})\b/g); if(five) kw.push(...five);
  const so=text.match(/SO[_\s]*0*(\d{4,7})/gi);
  if(so) for(const m of so){const n=m.match(/0*(\d{4,7})$/);if(n){kw.push(n[1]);kw.push(n[0]);}}
  const seven=text.match(/\b(00\d{5})\b/g);
  if(seven) for(const n of seven){kw.push(n);kw.push(n.replace(/^0+/,''));}
  const catl=text.match(/\b(20\d{2}-\d{3})\b/g); if(catl) kw.push(...catl);
  const cp=text.match(/contract\s*#?\s*(\d{4,7})/gi);
  if(cp) for(const m of cp){const n=m.match(/(\d{4,7})/);if(n) kw.push(n[1]);}
  return [...new Set(kw)];
}
async function findMatchingOrder(keywords: string[]): Promise<{id:string;order_number:string}|null> {
  if(!keywords.length) return null;
  for(const kw of keywords){const{data}=await supabase.from("orders").select("id,order_number").eq("mfg_contract_number",kw).limit(1).single();if(data) return data;}
  for(const kw of keywords){const{data}=await supabase.from("orders").select("id,order_number").eq("moly_contract_number",kw).limit(1).single();if(data) return data;}
  for(const kw of keywords){const{data}=await supabase.from("orders").select("id,order_number").eq("mfg_so_number",kw).limit(1).single();if(data) return data;}
  for(const kw of keywords){const{data}=await supabase.from("orders").select("id,order_number").eq("order_number",kw).limit(1).single();if(data) return data;}
  // Also try contract_name partial match
  for(const kw of keywords){
    const{data}=await supabase.from("orders").select("id,order_number").ilike("contract_name",`%${kw}%`).limit(1).single();
    if(data) return data;
  }
  return null;
}
function getMfgFromSender(from:string):string|null{
  for(const[d,s] of Object.entries(MFG_DOMAINS)) if(from.toLowerCase().includes(d)) return s;
  return null;
}
function hasMakeOrderTrigger(subj:string):boolean{
  const s=(subj||"").toLowerCase();
  return s.includes("make order")||s.includes("new order")||s.includes("create order");
}

// ---- Claude PDF Parsing (runs on EVERY PDF now) ----
async function parseMolyPdfWithClaude(pdfBase64:string, filename:string, docType:string): Promise<any>{
  console.log(`🤖 Parsing ${filename} (${docType})...`);
  const hint = docType.includes("invoice") ? "This is a Moly Manufacturing INVOICE." : "This is a Moly Manufacturing SALES ORDER / CONTRACT.";
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages",{
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({
        model:"claude-haiku-4-5-20251001",max_tokens:2000,
        messages:[{role:"user",content:[
          {type:"document",source:{type:"base64",media_type:"application/pdf",data:pdfBase64}},
          {type:"text",text:`${hint}\n\nParse and return ONLY valid JSON (no markdown, no backticks):\n{\n  "document_type": "sales_order" or "invoice" or "web_order_form",\n  "contract_number": "strip leading zeros (0044275 -> 44275)",\n  "customer_name": "Sold To / Ship To name",\n  "order_date": "YYYY-MM-DD",\n  "target_date": "YYYY-MM-DD or null",\n  "base_model": "e.g. Heavy Duty Wide Body, Ranch Standard, MAXX",\n  "chute_length": "Standard or Extended",\n  "floor_type": "Standard Floor or Rebar Floor",\n  "line_items": [{ "name": "option name", "quantity": 1, "list_price": number|null, "net_price": number|null, "discount_pct": number|null }],\n  "comments": "special instructions",\n  "list_price_total": number|null,\n  "discount_amount": number|null,\n  "subtotal": number|null,\n  "freight": number|null,\n  "tax": number|null,\n  "order_total": number,\n  "deposit_amount": number|null\n}\n\nline_items = every option EXCEPT the base model and deposit/discount lines.\nReturn ONLY JSON.`}
        ]}],
      }),
    });
    if(!resp.ok){console.error(`Claude API ${resp.status}: ${await resp.text()}`);return null;}
    const data=await resp.json();
    const tb=data.content?.find((c:any)=>c.type==="text");
    if(!tb?.text) return null;
    return JSON.parse(tb.text.replace(/```json\n?|```\n?/g,"").trim());
  } catch(e){console.error(`Parse error: ${e}`);return null;}
}

async function fillDocumentSlot(orderId:string, slotType:string, parsed:any, documentId:string|null):Promise<boolean>{
  const{error}=await supabase.from("order_document_slots").update({
    is_filled:true, filled_at:new Date().toISOString(), document_id:documentId,
    line_items:parsed.line_items||[], base_model:parsed.base_model||null,
    chute_length:parsed.chute_length||null, floor_type:parsed.floor_type||null,
    subtotal:parsed.subtotal||parsed.order_total||null, discount_amount:parsed.discount_amount||null,
    tax_amount:parsed.tax||null, freight_amount:parsed.freight||null, total_amount:parsed.order_total||null,
    raw_extracted_text:JSON.stringify(parsed), parsed_by:"claude-haiku", parse_confidence:0.95,
    comparison_status:"pending", updated_at:new Date().toISOString(),
  }).eq("order_id",orderId).eq("slot_type",slotType);
  if(error){console.error(`Slot fill failed ${slotType}:`,error);return false;}
  console.log(`✅ Filled ${slotType} for ${orderId}`);
  return true;
}

async function createOrderFromParsedContract(parsed:any):Promise<{id:string;order_number:string|null}|null>{
  const mk=(parsed.base_model||"").toLowerCase().trim();
  const mm=MOLY_MODEL_MAP[mk];
  const cn=parsed.customer_name||`Contract ${parsed.contract_number}`;
  const cnum=parsed.contract_number||null;
  const sp:string[]=[]; if(mm) sp.push(mm.short_name);
  const on=(parsed.line_items||[]).map((o:any)=>o.name).filter(Boolean);
  if(on.length){sp.push("w/ "+on.slice(0,4).join(", "));if(on.length>4) sp.push(`+${on.length-4} more`);}
  const so=(parsed.line_items||[]).map((o:any)=>({name:o.name,net_price:o.net_price,list_price:o.list_price,discount_pct:o.discount_pct,source:"moly_contract"}));
  const{data,error}=await supabase.from("orders").insert({
    contract_name:cn, mfg_contract_number:cnum, moly_contract_number:cnum,
    manufacturer_id:MOLY_MANUFACTURER_ID, base_model:mm?.name||parsed.base_model||"Unknown",
    base_model_id:mm?.id||null, build_shorthand:sp.join(" ")||"Silencer Chute",
    build_description:`${parsed.base_model||"Silencer"}, ${parsed.chute_length||"Standard"}, ${parsed.floor_type||"Standard Floor"}. Options: ${on.join(", ")||"none"}. ${parsed.comments||""}`.trim(),
    our_cost:parsed.order_total||null, status:"purchase_order",
    ordered_date:parsed.order_date||new Date().toISOString().split("T")[0],
    est_completion_date:parsed.target_date||null, selected_options:so,
    source_type:"direct", from_inventory:true,
    notes:`Auto-created from Moly contract ${cnum}. ${parsed.comments||""}`.trim(),
  }).select("id,order_number").single();
  if(error){console.error("Order create failed:",error);return null;}
  await supabase.from("order_timeline").insert({order_id:data.id,event_type:"order_created",
    title:"Order auto-created from emailed Moly contract",
    description:`Contract #${cnum} — ${parsed.base_model}. ${on.length} options. Total: $${parsed.order_total?.toLocaleString()||"unknown"}.`});
  return {id:data.id,order_number:data.order_number};
}

async function runSlotComparison(orderId:string):Promise<void>{
  const{data:slots}=await supabase.from("order_document_slots").select("*").eq("order_id",orderId).eq("is_filled",true);
  if(!slots||slots.length<2) return;
  for(let i=0;i<slots.length;i++){
    for(let j=i+1;j<slots.length;j++){
      const a=slots[i],b=slots[j];
      const ai=(a.line_items||[]) as any[], bi=(b.line_items||[]) as any[];
      const icm=ai.length===bi.length;
      const tm=Math.abs((a.total_amount||0)-(b.total_amount||0))<1;
      const mm=(a.base_model||"").toLowerCase()===(b.base_model||"").toLowerCase();
      const an=new Set(ai.map((x:any)=>(x.name||"").toLowerCase().trim()));
      const bn=new Set(bi.map((x:any)=>(x.name||"").toLowerCase().trim()));
      const mib=[...an].filter(n=>!bn.has(n)), mia=[...bn].filter(n=>!an.has(n));
      let st="match"; const notes:string[]=[];
      if(!mm){st="mismatch";notes.push(`Model: ${a.base_model} vs ${b.base_model}`);}
      if(!icm){st="partial";notes.push(`Items: ${ai.length} vs ${bi.length}`);}
      if(mib.length){st="mismatch";notes.push(`In ${a.slot_type} not ${b.slot_type}: ${mib.join(", ")}`);}
      if(mia.length){st="mismatch";notes.push(`In ${b.slot_type} not ${a.slot_type}: ${mia.join(", ")}`);}
      if(!tm){st=st==="match"?"partial":st;notes.push(`Total: $${a.total_amount} vs $${b.total_amount}`);}
      const cn=notes.length?notes.join("; "):"All items and totals match";
      const now=new Date().toISOString();
      await supabase.from("order_document_slots").update({comparison_status:st,comparison_notes:cn,last_compared_at:now,updated_at:now}).eq("id",a.id);
      await supabase.from("order_document_slots").update({comparison_status:st,comparison_notes:cn,last_compared_at:now,updated_at:now}).eq("id",b.id);
    }
  }
}

// ===== MAIN =====
Deno.serve(async(req:Request)=>{
  if(req.method!=="POST") return new Response("Method not allowed",{status:405});
  try{
    const event=await req.json();
    if(event.type!=="email.received") return new Response(JSON.stringify({ignored:true}),{status:200});

    const{email_id,from,to,subject,attachments}=event.data;
    console.log(`📧 from=${from}, subj="${subject}", att=${attachments?.length||0}`);

    const triggerMake=hasMakeOrderTrigger(subject||"");
    if(triggerMake) console.log("🚨 MAKE ORDER trigger");

    const attNames=(attachments||[]).map((a:any)=>a.filename||"").join(" ");
    const searchText=`${subject||""} ${from||""} ${attNames}`;
    const matchKw=extractMatchKeywords(searchText);
    console.log(`🔍 Keywords: ${JSON.stringify(matchKw)}`);

    let matched=await findMatchingOrder(matchKw);
    if(matched) console.log(`✅ Matched: ${matched.id}`);

    // Body keywords
    const emailRes=await fetch(`https://api.resend.com/emails/receiving/${email_id}`,{headers:{Authorization:`Bearer ${RESEND_API_KEY}`}});
    let emailBody="";
    if(emailRes.ok){const ed=await emailRes.json();emailBody=ed.text||ed.html||"";
      if(!matched&&emailBody){const bk=extractMatchKeywords(emailBody);if(bk.length){matchKw.push(...bk);matched=await findMatchingOrder(bk);}}}

    let finalOrder=matched;
    const processed:string[]=[], skipped:string[]=[];
    let orderCreated=false, slotsFilled:string[]=[];

    if(attachments&&attachments.length>0){
      const attRes=await fetch(`https://api.resend.com/emails/receiving/${email_id}/attachments`,{headers:{Authorization:`Bearer ${RESEND_API_KEY}`}});
      if(attRes.ok){
        const attList=(await attRes.json()).data||[];
        for(const att of attList){
          if(att.content_disposition==="inline"&&att.content_type?.startsWith("image/")){skipped.push(`${att.filename} (inline)`);continue;}
          if(!isAllowedFile(att.filename||"",att.content_type||"")){skipped.push(`${att.filename} (${att.content_type})`);continue;}
          try{
            const fr=await fetch(att.download_url); if(!fr.ok) continue;
            const fb=await fr.arrayBuffer(); const bytes=new Uint8Array(fb);
            const isPdf=(att.content_type||"").toLowerCase().includes("pdf")||(att.filename||"").toLowerCase().endsWith(".pdf");
            const docType=detectDocType(subject||"",att.filename||"");
            const slotType=docTypeToSlotType(docType);
            let parsed:any=null;

            // *** PARSE EVERY PDF with Claude ***
            if(isPdf){
              try {
                const b64=btoa(String.fromCharCode(...bytes));
                parsed=await parseMolyPdfWithClaude(b64,att.filename,docType);

                // If we got a contract number from the PDF, try matching again
                if(parsed?.contract_number && !finalOrder){
                  const pdfKw=[parsed.contract_number];
                  matchKw.push(...pdfKw);
                  finalOrder=await findMatchingOrder(pdfKw);
                  if(finalOrder) console.log(`✅ Matched from PDF content: ${finalOrder.id}`);
                }

                // Make Order trigger: create order if still no match
                if(triggerMake && !finalOrder && parsed?.contract_number){
                  const existing=await findMatchingOrder([parsed.contract_number]);
                  if(existing){finalOrder=existing;}
                  else{
                    const newOrd=await createOrderFromParsedContract(parsed);
                    if(newOrd){finalOrder=newOrd;orderCreated=true;}
                  }
                }
              } catch(parseErr){
                console.error(`PDF parse error for ${att.filename}:`,parseErr);
              }
            }

            // Upload to storage
            const safeName=sanitizeFilename(att.filename||`att_${Date.now()}`);
            const folder=finalOrder?finalOrder.id:"unmatched";
            const path=`${folder}/${email_id}/${safeName}`;
            const{error:upErr}=await supabase.storage.from("order-documents").upload(path,bytes,{contentType:att.content_type||"application/octet-stream",upsert:true});
            if(upErr){console.error(`Upload fail: ${safeName}`,upErr);continue;}

            // Insert document record
            const{data:docRec,error:insErr}=await supabase.from("order_documents").insert({
              order_id:finalOrder?.id||null, document_type:docType,
              title:att.filename||"Untitled", description:`From: ${from}\nSubject: ${subject}`,
              file_url:`order-documents/${path}`, file_name:safeName, file_type:att.content_type,
              file_size_bytes:att.size||bytes.length, source:"email",
              source_email_from:from, source_email_subject:subject, source_email_date:event.created_at,
              manufacturer_ref:parsed?.contract_number||matchKw[0]||null,
              resend_email_id:email_id, is_unmatched:!finalOrder,
              match_attempted_at:new Date().toISOString(), match_keywords:[...new Set(matchKw)],
            }).select("id").single();
            if(insErr){console.error(`DB fail: ${safeName}`,insErr);continue;}
            processed.push(att.filename);

            // Fill document slot if applicable
            if(finalOrder&&parsed&&slotType&&docRec){
              const filled=await fillDocumentSlot(finalOrder.id,slotType,parsed,docRec.id);
              if(filled) slotsFilled.push(slotType);
            }

            // Store parsed data on the document record for future re-matching
            if(parsed&&docRec){
              await supabase.from("order_documents").update({
                manufacturer_ref:parsed.contract_number||null,
                match_keywords:[...new Set([...matchKw,parsed.contract_number].filter(Boolean))],
              }).eq("id",docRec.id);
            }
          }catch(e){console.error(`Error: ${att.filename}`,e);}
        }
      }
    }

    // No attachments fallback
    if(processed.length===0&&skipped.length===0){
      await supabase.from("order_documents").insert({
        order_id:finalOrder?.id||null, document_type:detectDocType(subject||"",""),
        title:subject||"Email (no attachments)", description:`From: ${from}\n${emailBody.substring(0,500)}`,
        source:"email",source_email_from:from,source_email_subject:subject,source_email_date:event.created_at,
        manufacturer_ref:matchKw[0]||null,resend_email_id:email_id,is_unmatched:!finalOrder,
        match_attempted_at:new Date().toISOString(),match_keywords:[...new Set(matchKw)],
      });
    }

    // Timeline
    if(finalOrder&&processed.length>0){
      await supabase.from("order_timeline").insert({order_id:finalOrder.id,event_type:"document_received",
        title:`Email from ${getMfgFromSender(from)||from}`,
        description:`Subject: ${subject}. ${processed.length} doc(s).${slotsFilled.length?" Slots: "+slotsFilled.join(", ")+".":""}${orderCreated?" Order created.":""}`});
    }

    // Run comparison
    if(finalOrder&&slotsFilled.length>0) await runSlotComparison(finalOrder.id);

    return new Response(JSON.stringify({
      success:true, matched:!!finalOrder, order_created:orderCreated,
      order_id:finalOrder?.id||null, attachments_processed:processed.length,
      slots_filled:slotsFilled, skipped_files:skipped,
      keywords_found:[...new Set(matchKw)],
    }),{status:200,headers:{"Content-Type":"application/json"}});
  }catch(err){
    console.error("❌",err);
    return new Response(JSON.stringify({success:false,error:String(err)}),{status:200,headers:{"Content-Type":"application/json"}});
  }
});
