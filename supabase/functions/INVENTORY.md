# Edge Function Inventory — project `dubzwbfqlwhkpmpuejsy` (CRLE)

Captured 2026-07-15 via Supabase MCP `list_edge_functions`. **54 live functions.** Dates are UTC.

⚑ = `updated_at` falls within the death window **2026-04-25 → 2026-05-12**.  
`git?` = source present in this repo's `supabase/functions/<slug>/`.

| # | slug | ver | created | updated | jwt | git? | ⚑ |
|---|------|-----|---------|---------|-----|------|---|
| 1 | qb-auth-start | 11 | 2026-03-27 | 2026-03-27 | — | yes |  |
| 2 | qb-auth-callback | 12 | 2026-03-27 | 2026-03-27 | — | yes |  |
| 3 | qb-push-estimate | 88 | 2026-03-27 | 2026-04-05 | — | yes |  |
| 4 | send-estimate | 77 | 2026-03-27 | 2026-04-05 | — | yes |  |
| 5 | qb-debug | 10 | 2026-03-27 | 2026-03-27 | ✓ | yes |  |
| 6 | qb-sync-customers | 7 | 2026-03-27 | 2026-03-27 | — | yes |  |
| 7 | qb-push-po | 61 | 2026-03-28 | 2026-04-05 | — | yes |  |
| 8 | qb-vendor-lookup | 7 | 2026-03-28 | 2026-07-06 | — | yes |  |
| 9 | gmail-scan-invoices | 7 | 2026-03-28 | 2026-03-28 | ✓ | yes |  |
| 10 | google-oauth-callback | 7 | 2026-03-28 | 2026-03-29 | — | yes |  |
| 11 | process-inbound-email | 9 | 2026-03-28 | 2026-03-29 | — | yes |  |
| 12 | qb-list-items | 4 | 2026-03-29 | 2026-03-29 | — | yes |  |
| 13 | qb-sync-item-ids | 5 | 2026-03-29 | 2026-07-06 | — | yes |  |
| 14 | qb-lookup-linn | 5 | 2026-03-29 | 2026-07-06 | — | yes |  |
| 15 | qb-sync-items | 5 | 2026-03-29 | 2026-07-06 | — | yes |  |
| 16 | qb-convert-po-to-bill | 37 | 2026-03-29 | 2026-04-05 | — | yes |  |
| 17 | qb-convert-estimate-to-invoice | 37 | 2026-03-29 | 2026-04-05 | — | yes |  |
| 18 | manage-document | 3 | 2026-03-29 | 2026-03-29 | — | yes |  |
| 19 | qb-download-pdf | 4 | 2026-03-29 | 2026-03-30 | — | yes |  |
| 20 | compare-documents | 7 | 2026-03-31 | 2026-04-06 | — | yes |  |
| 21 | accept-sales-order | 3 | 2026-03-31 | 2026-03-31 | — | yes |  |
| 22 | qb-void-estimate | 3 | 2026-03-31 | 2026-03-31 | — | yes |  |
| 23 | qb-check-sync | 10 | 2026-03-31 | 2026-04-03 | — | yes |  |
| 24 | qb-void-document | 3 | 2026-03-31 | 2026-03-31 | — | yes |  |
| 25 | qb-list-purchase-orders | 3 | 2026-03-31 | 2026-03-31 | — | yes |  |
| 26 | qb-import-inventory-from-pos | 3 | 2026-03-31 | 2026-03-31 | — | yes |  |
| 27 | process-call-recording | 4 | 2026-03-31 | 2026-03-31 | — | yes |  |
| 28 | drive-link-orders | 3 | 2026-03-31 | 2026-03-31 | — | yes |  |
| 29 | drive-link-folders | 3 | 2026-03-31 | 2026-03-31 | — | yes |  |
| 30 | drive-test-create-folder | 4 | 2026-03-31 | 2026-07-06 | — | yes |  |
| 31 | drive-create-and-link-folders | 3 | 2026-03-31 | 2026-03-31 | — | yes |  |
| 32 | drive-link-existing-only | 4 | 2026-03-31 | 2026-03-31 | — | yes |  |
| 33 | process-voice-memo | 4 | 2026-04-01 | 2026-04-01 | — | yes |  |
| 34 | drive-watch-memos | 13 | 2026-04-01 | 2026-04-07 | — | yes |  |
| 35 | chat-assistant | 13 | 2026-04-01 | 2026-04-07 | — | yes |  |
| 36 | upload-44270-docs | 2 | 2026-04-01 | 2026-07-06 | — | yes |  |
| 37 | drive-scan-documents | 7 | 2026-04-01 | 2026-04-04 | — | yes |  |
| 38 | gmail-scan | 6 | 2026-04-02 | 2026-04-07 | — | yes |  |
| 39 | gmail-download-attachment | 3 | 2026-04-02 | 2026-04-03 | — | yes |  |
| 40 | reprocess-stuck-memos | 1 | 2026-04-02 | 2026-04-02 | — | yes |  |
| 41 | link-document-to-slot | 5 | 2026-04-02 | 2026-04-04 | — | yes |  |
| 42 | qb-po-diagnose | 2 | 2026-04-02 | 2026-07-06 | — | yes |  |
| 43 | qb-diagnostic | 2 | 2026-04-02 | 2026-07-06 | — | yes |  |
| 44 | list-drive-files | 1 | 2026-04-02 | 2026-04-02 | — | yes |  |
| 45 | batch-qb-sync | 3 | 2026-04-03 | 2026-04-03 | — | yes |  |
| 46 | extract-document-text | 2 | 2026-04-03 | 2026-04-06 | — | yes |  |
| 47 | qb-find-estimates | 4 | 2026-04-03 | 2026-04-05 | — | yes |  |
| 48 | qb-debug-bills | 2 | 2026-04-05 | 2026-07-06 | — | yes |  |
| 49 | reprocess-stuck-calls | 1 | 2026-04-29 | 2026-04-29 | — | yes | ⚑ |
| 50 | drive-burst-process | 2 | 2026-04-29 | 2026-04-29 | — | yes | ⚑ |
| 51 | submit-lead | 1 | 2026-06-17 | 2026-06-17 | — | yes |  |
| 52 | qb-refresh-token | 1 | 2026-07-07 | 2026-07-07 | ✓ | **NO** |  |
| 53 | qb-lookup-pos-by-docnumber | 3 | 2026-07-07 | 2026-07-07 | ✓ | **NO** |  |
| 54 | freight-share | 1 | 2026-07-09 | 2026-07-09 | — | **NO** |  |

**Flagged in death window (updated 2026-04-25→2026-05-12):** reprocess-stuck-calls, drive-burst-process

**Live but missing from git (3):** qb-refresh-token, qb-lookup-pos-by-docnumber, freight-share

Note: a large cluster of functions shows `updated 2026-07-06` — a bulk redeploy (the QB 'Retired —' stubs and other housekeeping), unrelated to the death window.

---

## drive-watch-memos — call/memo dedup (v15, 2026-07-17)
- **The bug it fixes:** the function wrote a `voice_memos` row for every call *in
  addition to* the canonical `call_log` row, so one recording produced two
  transcripts. `call_log` is canonical for calls; `voice_memos` is memos only.
- **Skip / guard rules now in the function:**
  1. Calls route to `call_log` ONLY — the duplicate `voice_memos` insert is
     removed.
  2. Recording-key idempotency check before any work: derive the stable key
     (`${recordedBy}_${sanitizedFilename}`, i.e. the stored path minus the upload
     timestamp — the same key the Hub screen-side dedupe uses) and skip if a
     `call_log` OR `voice_memos` row already carries it. Logs `duplicate-prevented`.
  3. Backed by a DB unique index on `voice_memos(recording_key)` (migration
     `20260717000000_voice_memos_recording_key_guard.sql`) so no future code
     change can reintroduce the dup.
- **Census flag — bucket naming:** calls do NOT live in the `call-recordings`
  bucket (it is **empty / unused**). Both calls and memos land in the
  `voice-memos` bucket; calls under the `calls/` prefix. `process-call-recording`
  (the legacy BCR push path → `call-recordings`) is currently dormant — 0 calls
  in the last 7 days; **drive-watch-memos is the live call source.** Flagging the
  bucket naming for the census; not renaming anything now.
