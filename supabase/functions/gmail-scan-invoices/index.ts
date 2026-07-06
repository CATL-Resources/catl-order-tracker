import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") || "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// --- Google Token Management ---
async function getGoogleAccessToken(): Promise<string> {
  const { data: tokenRow, error } = await supabase
    .from("google_tokens")
    .select("*")
    .limit(1)
    .single();
  if (error || !tokenRow) throw new Error("No Google token found. Tim needs to connect Google account first.");

  const now = new Date();
  const expiresAt = new Date(tokenRow.access_token_expires_at);

  if (now < expiresAt) return tokenRow.access_token;

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: tokenRow.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const tokenData = await resp.json();
  if (!tokenData.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(tokenData)}`);

  const newExpiry = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString();
  await supabase.from("google_tokens").update({
    access_token: tokenData.access_token,
    access_token_expires_at: newExpiry,
    updated_at: new Date().toISOString(),
  }).eq("id", tokenRow.id);

  return tokenData.access_token;
}

// --- Gmail API Helpers ---
async function gmailSearch(accessToken: string, query: string, maxResults = 50): Promise<any[]> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await resp.json();
  return data.messages || [];
}

async function gmailGetMessage(accessToken: string, messageId: string): Promise<any> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  return await resp.json();
}

async function gmailGetAttachment(accessToken: string, messageId: string, attachmentId: string): Promise<Uint8Array> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await resp.json();
  const base64 = data.data.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- Google Drive Helpers ---
async function uploadToDrive(accessToken: string, fileName: string, fileBytes: Uint8Array, folderId: string, mimeType = "application/pdf"): Promise<{ id: string; webViewLink: string }> {
  const metadata = { name: fileName, parents: [folderId], mimeType };
  const boundary = "----FormBoundary" + Date.now();
  const metadataPart = JSON.stringify(metadata);

  const encoder = new TextEncoder();
  const parts = [
    encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataPart}\r\n`),
    encoder.encode(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    fileBytes,
    encoder.encode(`\r\n--${boundary}--`),
  ];

  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.length; }

  const resp = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  return await resp.json();
}

// --- Drive Folder Lookup (year-specific, then catch-all 9999) ---
async function findDriveFolder(manufacturerId: string, emailDate: string): Promise<string | null> {
  const emailYear = new Date(emailDate).getFullYear() || new Date().getFullYear();

  // Try exact year first
  const { data: exactFolder } = await supabase
    .from("drive_folders")
    .select("folder_id")
    .eq("manufacturer_id", manufacturerId)
    .eq("year", emailYear)
    .single();
  if (exactFolder) return exactFolder.folder_id;

  // Fall back to catch-all (year = 9999, for mfrs without year-based folders)
  const { data: catchAll } = await supabase
    .from("drive_folders")
    .select("folder_id")
    .eq("manufacturer_id", manufacturerId)
    .eq("year", 9999)
    .single();
  if (catchAll) return catchAll.folder_id;

  // Last resort: manufacturer's parent folder
  const { data: mfr } = await supabase
    .from("manufacturers")
    .select("google_drive_parent_folder_id")
    .eq("id", manufacturerId)
    .single();
  return mfr?.google_drive_parent_folder_id || null;
}

// --- Contract Number Extraction ---
function extractContractNumber(subject: string): string | null {
  // Moly auto-invoices: subject ends with 7+ digit number like 0043182
  const autoInvoiceMatch = subject.match(/(\d{7,})\s*$/);
  if (autoInvoiceMatch) return String(parseInt(autoInvoiceMatch[1], 10));
  // "Contract XXXXX" or "Sales Order XXXXX"
  const contractMatch = subject.match(/(?:contract|sales order|order|invoice)\s*#?\s*(\d{4,6})/i);
  if (contractMatch) return contractMatch[1];
  // Filename pattern in subject: "44269_CATL"
  const filePattern = subject.match(/(\d{5})_CATL/i);
  if (filePattern) return filePattern[1];
  return null;
}

// Also try to extract contract number from attachment filenames
function extractContractFromFilename(filename: string): string | null {
  // Pattern: SO_0043182IN or just 00XXXXX in the filename
  const soMatch = filename.match(/SO_0*(\d{5,})/i);
  if (soMatch) return soMatch[1];
  const numMatch = filename.match(/00(\d{5})/i);
  if (numMatch) return numMatch[1];
  return null;
}

// --- Main Scan Logic ---
async function scanForDocuments(options: { contractNumbers?: string[]; maxResults?: number; dryRun?: boolean; senderFilter?: string }) {
  const accessToken = await getGoogleAccessToken();
  const results: any[] = [];
  const errors: any[] = [];

  // Get active scan sources
  const { data: sources } = await supabase.from("doc_scan_sources").select("*").eq("is_active", true);
  if (!sources?.length) return { error: "No active scan sources configured" };

  // Build Gmail search query
  let senderQueries: string;
  if (options.senderFilter) {
    senderQueries = `from:${options.senderFilter}`;
  } else {
    senderQueries = sources.map(s => `from:${s.sender_email}`).join(" OR ");
  }
  let query = `(${senderQueries}) has:attachment`;

  if (options.contractNumbers?.length) {
    const contractQuery = options.contractNumbers.map(c => {
      const padded = c.padStart(7, "0");
      return `${padded} OR ${c}`;
    }).join(" OR ");
    query += ` (${contractQuery})`;
  }

  console.log("Gmail query:", query);
  const messages = await gmailSearch(accessToken, query, options.maxResults || 100);
  console.log(`Found ${messages.length} messages`);

  for (const msg of messages) {
    try {
      // Skip if already scanned
      const { data: existing } = await supabase
        .from("doc_scan_log")
        .select("id")
        .eq("gmail_message_id", msg.id)
        .single();
      if (existing) { results.push({ messageId: msg.id, status: "already_scanned" }); continue; }

      const fullMsg = await gmailGetMessage(accessToken, msg.id);
      const headers = fullMsg.payload?.headers || [];
      const subject = headers.find((h: any) => h.name.toLowerCase() === "subject")?.value || "";
      const from = headers.find((h: any) => h.name.toLowerCase() === "from")?.value || "";
      const date = headers.find((h: any) => h.name.toLowerCase() === "date")?.value || "";

      let contractNumber = extractContractNumber(subject);

      // Find PDF attachments (check both top-level parts and nested)
      const allParts: any[] = [];
      function collectParts(parts: any[]) {
        for (const p of parts) {
          allParts.push(p);
          if (p.parts) collectParts(p.parts);
        }
      }
      if (fullMsg.payload?.parts) collectParts(fullMsg.payload.parts);
      else if (fullMsg.payload?.body?.attachmentId) allParts.push(fullMsg.payload);

      const pdfParts = allParts.filter((p: any) =>
        (p.mimeType === "application/pdf" || (p.filename && p.filename.toLowerCase().endsWith(".pdf")))
        && p.body?.attachmentId
      );

      if (pdfParts.length === 0) {
        await supabase.from("doc_scan_log").insert({
          gmail_message_id: msg.id, gmail_thread_id: msg.threadId,
          subject, sender_email: from, status: "no_pdf_attachment",
        });
        results.push({ messageId: msg.id, subject, status: "no_pdf_attachment" });
        continue;
      }

      for (const pdfPart of pdfParts) {
        const filename = pdfPart.filename || `document_${contractNumber || "unknown"}.pdf`;

        // Try filename for contract number if subject didn't yield one
        if (!contractNumber) contractNumber = extractContractFromFilename(filename);

        if (options.dryRun) {
          results.push({ messageId: msg.id, subject, from, date, contractNumber, filename, status: "dry_run" });
          continue;
        }

        // Download attachment
        const pdfBytes = await gmailGetAttachment(accessToken, msg.id, pdfPart.body.attachmentId);

        // Find Drive folder
        const matchedSource = sources.find(s => from.toLowerCase().includes(s.sender_email.toLowerCase()));
        let driveFolderId: string | null = null;
        if (matchedSource?.manufacturer_id) {
          driveFolderId = await findDriveFolder(matchedSource.manufacturer_id, date);
        }

        let driveFileId: string | null = null;
        let driveFileUrl: string | null = null;

        if (driveFolderId) {
          try {
            const driveResult = await uploadToDrive(accessToken, filename, pdfBytes, driveFolderId);
            driveFileId = driveResult.id || null;
            driveFileUrl = driveResult.webViewLink || null;
          } catch (e: any) {
            console.error("Drive upload failed:", e.message);
            errors.push({ messageId: msg.id, error: `Drive upload: ${e.message}` });
          }
        }

        // Match to order
        let matchedOrderId: string | null = null;
        if (contractNumber) {
          const { data: order } = await supabase
            .from("orders")
            .select("id")
            .eq("moly_contract_number", contractNumber)
            .single();
          if (order) matchedOrderId = order.id;
        }

        const docType = matchedSource?.document_type || "invoice";

        // Create order_documents record
        let documentId: string | null = null;
        if (matchedOrderId) {
          const { data: doc } = await supabase.from("order_documents").insert({
            order_id: matchedOrderId,
            document_type: docType,
            title: filename,
            file_name: filename,
            file_url: driveFileUrl,
            source: "gmail_scan",
            source_email_from: from,
            source_email_subject: subject,
            source_email_date: date,
            manufacturer_ref: contractNumber,
            is_unmatched: false,
          }).select("id").single();
          documentId = doc?.id || null;
        } else if (contractNumber) {
          // Unmatched but has contract number — still save the doc
          const { data: doc } = await supabase.from("order_documents").insert({
            document_type: docType,
            title: filename,
            file_name: filename,
            file_url: driveFileUrl,
            source: "gmail_scan",
            source_email_from: from,
            source_email_subject: subject,
            source_email_date: date,
            manufacturer_ref: contractNumber,
            is_unmatched: true,
            match_keywords: [contractNumber],
          }).select("id").single();
          documentId = doc?.id || null;
        }

        // Log the scan
        await supabase.from("doc_scan_log").insert({
          gmail_message_id: msg.id, gmail_thread_id: msg.threadId,
          subject, sender_email: from,
          status: matchedOrderId ? "matched" : (contractNumber ? "unmatched" : "no_contract_number"),
          matched_order_id: matchedOrderId,
          matched_contract_number: contractNumber,
          document_id: documentId,
          drive_file_id: driveFileId, drive_file_url: driveFileUrl,
          attachment_filename: filename,
          attachment_size_bytes: pdfBytes.length,
        });

        results.push({
          messageId: msg.id, subject, from, contractNumber, filename,
          matched: !!matchedOrderId, driveUrl: driveFileUrl,
          status: matchedOrderId ? "matched" : (contractNumber ? "unmatched" : "no_contract_number"),
        });
      }
    } catch (e: any) {
      console.error(`Error processing message ${msg.id}:`, e.message);
      errors.push({ messageId: msg.id, error: e.message });
    }
  }

  await supabase.from("app_settings").update({
    value: new Date().toISOString(), updated_at: new Date().toISOString()
  }).eq("key", "doc_scan_last_run");

  return {
    query,
    messagesFound: messages.length,
    processed: results.filter(r => r.status !== "already_scanned").length,
    matched: results.filter(r => r.status === "matched").length,
    unmatched: results.filter(r => r.status === "unmatched").length,
    skipped: results.filter(r => r.status === "already_scanned").length,
    errors: errors.length,
    results,
    ...(errors.length > 0 ? { errorDetails: errors } : {}),
  };
}

// --- HTTP Handler ---
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "scan";

    if (action === "scan") {
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      const result = await scanForDocuments({
        contractNumbers: body.contractNumbers,
        maxResults: body.maxResults || 50,
        dryRun: body.dryRun || false,
        senderFilter: body.senderFilter,
      });
      return new Response(JSON.stringify(result, null, 2), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "status") {
      const { data: logs } = await supabase
        .from("doc_scan_log")
        .select("status")
        .order("scanned_at", { ascending: false })
        .limit(500);
      const counts = (logs || []).reduce((acc: any, l: any) => {
        acc[l.status] = (acc[l.status] || 0) + 1;
        return acc;
      }, {});
      const { data: lastRun } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "doc_scan_last_run")
        .single();
      const { data: tokenStatus } = await supabase
        .from("google_tokens")
        .select("account_email, updated_at")
        .limit(1)
        .single();
      return new Response(JSON.stringify({
        googleConnected: !!tokenStatus,
        googleAccount: tokenStatus?.account_email,
        lastRun: lastRun?.value,
        scanCounts: counts,
      }, null, 2), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Use ?action=scan or ?action=status" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("Scan error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
