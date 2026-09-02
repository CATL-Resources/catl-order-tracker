# Project Memory

> Last updated: 2026-09-01
> Total entries: 37

---

## [2026-03-29] — App Architecture & Purpose Map

**Category:** Status
**Project:** CATL Resources

### What Is The CATL Equipment Manager?

A web app for CATL Resources, a livestock equipment dealership in the Northern Great Plains. It replaces spreadsheets, Notion boards, and manual QB data entry with a single system that tracks every piece of equipment from quote to delivery.

### Who Uses It

- **Tim Olson** — customer-facing. Talks to ranchers, builds quotes, tracks orders, works with manufacturers.
- **Chandy Olson** — builder/owner. No technical background. Builds via Lovable + Claude Code + Claude chat.

### The Two Workflows

**Estimate Path (customer calls for a quote):**
1. Customer calls Tim asking about a chute
2. Tim opens the app, creates an estimate (auto-numbered 2026EST-001)
3. Configures the chute (base model + options via the configurator)
4. Sends estimate to customer via email (Resend) and/or pushes to QuickBooks
5. Customer says yes → "Convert to Order" with three fulfillment options:
   - Order new from manufacturer
   - Assign to equipment already on order (spec matching with colored pills)
   - Sell from existing inventory on the lot
6. Order tracks through: purchase_order → order_pending → building → ready → delivered

**Direct Order Path (ordering from manufacturer for inventory):**
1. Tim orders equipment from Moly/Daniels/etc. for inventory (no customer yet)
2. Creates a direct order with MOLY contract number as the identifier
3. No auto-generated number — the MOLY contract # IS the order number
4. Equipment sits in inventory until a customer buys it
5. When customer buys → assign customer, create estimate with CATL mod add-ons

### Identifiers (settled 2026-03-29)

- **Orders:** MOLY contract number is the primary identifier. No more auto-generated 2026-001 numbers. `order_number` column is nullable.
- **Estimates:** Auto-generated `2026EST-001` format via `generate_estimate_number()` database function. Pushed to QB as `DocNumber`.
- **Contract Name:** Human-readable name like "Smith Ranch Chute" — primary display on cards and headers.

### Manufacturers

| Manufacturer | Short | Products |
|---|---|---|
| Moly Manufacturing (Silencer) | MOLY | Chutes (Ranch, HD, CP, MAXX, Tilt variants) |
| Daniels | DAN | Alleys, Loading Chutes, Panels |
| Rawhide | RAW | Portable Processors |
| MJE/Conquistador | MJE | Wheel Corrals, Calf Tables, Alleys, 3-Way Sorts |
| LEM/Rupp | LEM | Calf Tables, Power Units |
| Linn | LINN | Gates, Panels, Tubs, Continuous Fence |

---

## [2026-03-29] — Tech Stack & Infrastructure

**Category:** Status
**Project:** CATL Resources

### Stack

- **Frontend:** Lovable (UI builder) → GitHub `chandyolson/catl-order-tracker`
- **Backend:** Supabase project "CRLE" (`dubzwbfqlwhkpmpuejsy`)
- **Database:** PostgreSQL via Supabase
- **Edge Functions:** Deno on Supabase (12+ functions deployed)
- **Email:** Resend, sends from `tim@catlresources.com` (verified via GoDaddy DNS)
- **Accounting:** QuickBooks Online via OAuth
- **Design System:** ChuteSide — cream #F5F5F0, navy #0E2646, teal #55BAAA, gold #F3D12A, Inter font

### Database Tables (core)

| Table | Purpose |
|---|---|
| `orders` | Central table — an order IS an inventory item when `customer_id` is null and `from_inventory` is true |
| `estimates` | Quotes tied to orders. Has `estimate_number` (2026EST-001), `qb_estimate_id`, `qb_doc_number` |
| `customers` | 2,307 records bulk-synced from QuickBooks |
| `manufacturers` | 6 manufacturers with `qb_vendor_id` |
| `base_models` | 27 models with `qb_item_name` and `qb_item_id` |
| `model_options` | 72 options with `qb_item_name`, `qb_item_id`, `qb_item_name_by_model` (JSONB) |
| `order_timeline` | Activity feed per order |
| `order_documents` | Paperwork attachments |
| `paperwork` | Paperwork checklist items per order |
| `email_log` | Sent email audit trail |
| `qb_tokens` | QuickBooks OAuth tokens (auto-refresh) |
| `quick_builds` | Preset option bundles (e.g., "CATL Special") |

### Edge Functions (deployed)

| Function | Purpose | Key Detail |
|---|---|---|
| `qb-push-estimate` | Push estimate to QB with individual line items at retail | Uses `qb_item_id` for ItemRef.value |
| `qb-push-po` | Push purchase order to QB with line items at cost | Every line MUST have ItemRef |
| `send-estimate` | Email estimate to customer via Resend | MUST send from `tim@catlresources.com` |
| `qb-auth-start` | Begin QB OAuth flow | Stable |
| `qb-auth-callback` | Complete QB OAuth flow | Stable |
| `qb-sync-customers` | Bulk sync customers from QB | Paginated, 500/page |
| `qb-debug` | Token diagnostics | Utility |
| `qb-vendor-lookup` | One-off vendor search | Utility |
| `qb-sync-item-ids` | Fetch all QB items and populate qb_item_id columns | Run once, matched 98/99 |
| `google-oauth-callback` | Google OAuth for Tim's Gmail/Drive | Active |
| `gmail-scan-invoices` | Scan Gmail for manufacturer invoices, upload to Drive | Active |
| `process-inbound-email` | Inbound email webhook | Active |

### App Pages/Routes

| Route | Page | Status |
|---|---|---|
| `/` | Dashboard (KPIs + attention items + search bar + recent orders) | Done |
| `/orders` | Order list with cards | Done |
| `/orders/new` | New order/estimate form (configurator) | Done |
| `/orders/:id` | Order detail hub (5 tabs: Overview, Estimates, Paperwork, Timeline, Change Orders) | Done |
| `/orders/:id/edit` | Edit order (configurator) | Done |
| `/orders/:id/match` | Equipment match screen (assign to on-order or inventory) | Done |
| `/estimates` | Open estimates grouped by customer | Done |
| `/production` | Production kanban/list view | Done |
| `/paperwork` | Paperwork dashboard | Done |
| `/customers` | Customer directory | Done |
| `/customers/:id` | Customer detail | Done |
| `/settings` | Settings page | Done |
| `/inventory` | Equipment inventory | Placeholder only |
| `/documents` | Document management | Scaffolded, not deployed |

---

## [2026-03-29] — Estimate Numbering System Established

**Category:** Decision
**Project:** CATL Resources

Killed the auto-generated system order numbers (2026-001, 2026-002). Replaced with:
- **Estimates:** `2026EST-001` format, auto-generated by `generate_estimate_number()` PostgreSQL function. Sent to QB as `DocNumber` so both systems use the same number.
- **Orders:** MOLY contract number typed in by Tim. No auto-generation. The `order_number` column is now nullable.
- **Rationale:** CATL thinks in contract numbers and customer names, not system-generated IDs. The old numbers were meaningless.

---

## [2026-03-29] — QB Item ID Resolution Fixed

**Category:** Lesson
**Project:** CATL Resources

QuickBooks `ItemRef` requires `{ value: "1384", name: "Item Name" }` — not just `{ name: "Item Name" }`. Sending name alone causes QB to ignore the reference and fall back to the default "Services" item (ID=1). This is why estimates were showing as a single "Services" line item instead of individual equipment lines.

Fix: Created `qb-sync-item-ids` edge function that queries all 613 QB items, matches by `FullyQualifiedName`, and writes the numeric QB item ID back to `base_models.qb_item_id` and `model_options.qb_item_id`. 98/99 matched automatically. The one miss (Linn 12ft Panel) was a hierarchy mismatch — QB had it at the top level, not under `Livestock Equipment:Linn`.

---

## [2026-03-29] — QB PO Missing ItemRef Fixed

**Category:** Lesson
**Project:** CATL Resources

The QB Purchase Order API requires `ItemRef` on every `ItemBasedExpenseLineDetail` line. If ANY line is missing `ItemRef`, QB returns error code 2020 for every line in the payload. The fix was two-fold:
1. Every line now has `ItemRef` — falls back to "Cost of Goods Sold" if no mapping exists
2. Added `qb_item_id` (numeric value) to ItemRef alongside the name

---

## [2026-03-29] — Edge Function Error Visibility Fixed

**Category:** Lesson
**Project:** CATL Resources

`supabase.functions.invoke()` throws a generic "Edge Function returned a non-2xx status code" error when the function returns HTTP 500, hiding the actual error message in the response body. The frontend never sees the real QB API error.

Fix: Changed all edge functions to return HTTP 200 even on errors, with `{ success: false, error: "actual message" }` in the body. The frontend already checks `data.success` — it just never got to read `data` because the 500 status threw first.

---

## [2026-03-29] — Lovable Overwrites Edge Functions On Every Deploy

**Category:** Blocker
**Project:** CATL Resources

**This is the #1 operational headache.** Every time Lovable deploys (which happens when any frontend change is made), it redeploys its cached versions of ALL edge functions. This overwrites fixes deployed via Claude Code or the Supabase dashboard.

**Pattern:** Deploy correct function via Supabase MCP → user makes UI change in Lovable → Lovable redeploys stale cached version → function is broken again.

**Mitigation (partial):** Committed correct function source to `supabase/functions/*/index.ts` in the git repo. Lovable should now deploy from these files instead of its cache. Not yet confirmed this fully works.

**Examples of things Lovable has overwritten:**
- `send-estimate` from address: `tim@catlresources.com` → `estimates@catl.equipment` (unverified, Resend rejects it)
- `qb-push-estimate` line items: individual items with ItemRef → single lump "Services" line
- `qb-push-po` ItemRef: present on all lines → missing on all lines (causes QB 400 error)

---

## [2026-03-29] — Contract Name and MOLY Contract # Fields Added to Order Form

**Category:** Status
**Project:** CATL Resources

These fields existed in the database and on the Order Detail overview tab (click-to-edit), but were NEVER on the NewOrder or EditOrder forms. Added:
- State variables for both fields
- Two-column input row between Customer and Equipment sections
- Included in the Supabase insert (NewOrder) and update (EditOrder) calls
- EditOrder pre-fills from existing order data

This has been requested "for the 10th time" — the lesson is that Lovable's incremental prompts kept dropping these fields.

---

## [2026-03-29] — Search Bar Added to Dashboard

**Category:** Status
**Project:** CATL Resources

Global search bar on the dashboard that searches across orders (by contract name, MOLY #, build shorthand), estimates (by estimate number, QB doc number, build shorthand), and customers (by name, email, phone). Results grouped by type, clickable to navigate to detail pages. Debounced 300ms.

---

## [2026-03-29] — Delete Estimates Feature Added

**Category:** Status
**Project:** CATL Resources

Red trash icon on each estimate row in the Estimates page. Confirmation dialog shows estimate number, model name, and price. Deletes from Supabase and refreshes the list.

---

## [2026-03-28] — Orders Table IS the Inventory Table

**Category:** Decision
**Project:** CATL Resources

There is no separate inventory table. An order becomes "inventory" when `customer_id` is null and `from_inventory` is true. The three buckets for the inventory view:
1. **Assigned to customer** — `customer_id` is set
2. **In inventory (on lot)** — `from_inventory = true`, `status = 'ready'`, no customer
3. **On order (being built)** — `from_inventory = true`, `status IN ('purchase_order', 'order_pending', 'building')`, no customer

---

## [2026-03-28] — 26 Inventory Items Loaded from Notion

**Category:** Status
**Project:** CATL Resources

Pulled inventory from Tim's Notion Equipment board. After filtering out items with customer names in the contract name field (sloppy data entry), landed on 26 genuine inventory items:
- 6 ready/available on lot (contracts 43182, 43632, 43951, 43952, 43959, 44274)
- 3 on order with specs (contracts 44270, 44276, 44509)
- 2 on order, partially spec'd (contracts 44507, 44508)
- 15 on order, needs specs from Tim (contracts 44510-44512, 44515-44526)

**NOTE:** These were in the database but the orders table got wiped at some point. Need to re-import.

---

## [2026-03-28] — 88 Estimates Imported from QB PDF

**Category:** Status
**Project:** CATL Resources

Parsed 100 QB estimates from a 161-page PDF. 88 imported ($2,546,412.66 total), 12 skipped (junk/duplicates). QB estimate numbers #1643 through #1738. All linked to customers via fuzzy matching.

**NOTE:** These were in the database but the estimates table got wiped. Need to re-import.

---

## [2026-03-28] — Gmail → Drive → Supabase Document Pipeline Built

**Category:** Status
**Project:** CATL Resources

Full pipeline for automatically scanning Tim's Gmail for manufacturer invoices/paperwork:
- 17 email trigger entries across 4 manufacturers (Moly 7, Daniels 2, Rawhide 4, MJE 4)
- Downloads PDF attachments, uploads to manufacturer-specific Google Drive folders
- Matches to orders by contract number
- Creates `order_documents` records

Tim's Google account connected (timselect@gmail.com). Tokens stored. First manual scan hasn't been run yet.

---

## [2026-03-28] — GitHub Direct Push > Lovable Prompts

**Category:** Decision
**Project:** CATL Resources

Switched from writing Lovable prompts to pushing code directly via GitHub token. Lovable drops changes and partially implements incremental prompts. Direct push is precise and immediate. Token is per-session via `git remote set-url`.

---

## [2026-03-28] — Activity Tab Two-Column Layout

**Category:** Decision
**Project:** CATL Resources

Order detail Activity tab redesigned:
- **Left column (Timeline):** Completed paperwork, calls, emails, notes, QB events, status changes. Chronological, oldest at top.
- **Right column (To Do):** Pending paperwork as clickable checkboxes. Click to complete → moves to timeline.
- **Mobile:** Stacks vertically.
- Completed paperwork shows teal link icon if `document_url` exists.

---

## [2026-03-28] — QB Vendor Name Is Case-Sensitive

**Category:** Lesson
**Project:** CATL Resources

QB vendor name matching is case-sensitive. "MOLY Manufacturing" ≠ "Moly Manufacturing". Updated `manufacturers.name` to match QB's exact casing. Also cached `qb_vendor_id = "2003"` to use numeric ID instead of name matching going forward.

---

## [2026-03-28] — Supabase Select Must Include Every Field the UI Reads

**Category:** Lesson
**Project:** CATL Resources

If the UI checks `manufacturer.ordering_portal_url` but the Supabase query doesn't select that field, it's `undefined` and the UI silently hides the feature. The MOLY portal button was invisible because of this. Always audit the select query when a UI element disappears.

---

## [2026-03-28] — Email Must Use Verified Domain

**Category:** Lesson
**Project:** CATL Resources

Resend rejects emails from `estimates@catl.equipment` (domain not verified). Must use `tim@catlresources.com` (verified via GoDaddy DNS). Lovable keeps overwriting this — it's the most frequently reverted fix.

---

## [2026-03-28] — QB Refresh Token Expires July 6, 2026

**Category:** Blocker
**Project:** CATL Resources

The QuickBooks refresh token expires on July 6, 2026. When it does, Tim will need to re-authorize the QB connection. Need to build an alert/reminder before that date, or automate the re-auth flow.

---

## [2026-03-28] — Supabase Bulk Upsert Requires UNIQUE Constraint

**Category:** Lesson
**Project:** CATL Resources

Supabase `ON CONFLICT` requires a proper `UNIQUE` constraint (`ALTER TABLE ... ADD CONSTRAINT ... UNIQUE`), not a partial index. Partial indexes don't satisfy `ON CONFLICT`. Discovered during customer bulk sync from QB.

---

## [2026-03-28] — Large Syncs Need Pagination + Single Upsert Per Page

**Category:** Lesson
**Project:** CATL Resources

The QB customer sync (2,307 records) must use paginated bulk fetch (500 records/page) + single upsert per page to stay within the 60-second edge function timeout. Can't fetch all records then upsert — too slow.

---

## [2026-03-28] — GENERATED ALWAYS AS Columns Break Supabase Inserts

**Category:** Lesson
**Project:** CATL Resources

Computed columns using `GENERATED ALWAYS AS` cause insert failures in Supabase because the generated column is included in the insert statement. Replace with regular columns + `BEFORE INSERT OR UPDATE` triggers instead.

---

## [2026-03-28] — Incremental Lovable Prompts Lose Changes

**Category:** Lesson
**Project:** CATL Resources

Incremental Lovable prompts (small patches to existing components) lose changes from previous prompts. Use a single master prompt to replace entire components rather than patching. This is why contract name fields kept disappearing — each new prompt didn't include them.

---

## [2026-03-28] — Configurator Business Rules (Hard-Won)

**Category:** Decision
**Project:** CATL Resources

These rules are NOT in any manufacturer documentation — learned through trial and error:
- Dual Controls and Pivot Controls are independent products that can be combined (not mutually exclusive)
- Pivot Controls: Side-to-Side (with dominant side) or Front-to-Back (with mounted side)
- CATL Special quick build: XP Squeeze, Dual Controls, Neck Access (both), Walk-Through Doors (both), Louvers, Rear Hook-Up, two Neckbars (NOT HNB Neck Extender Bars)
- Yearling Sidegate is per-side, not whole-chute
- Yoke, Heavy Yoke, Carry-All work on standard AND extended chutes; only Hydraulic Yoke Carrier has an extended version
- Hydraulic Lower Squeeze pricing varies by base model ($1,448 Ranch → $2,564 HD Wide Body)

---

## [2026-03-29] — Data Wipe — Orders and Estimates Tables Empty

**Category:** Blocker
**Project:** CATL Resources

Both `orders` and `estimates` tables are empty (0 rows). The 26 inventory items and 88 imported estimates got wiped at some point. Customers survived (2,307 still there). Unknown cause — possibly a Lovable migration or accidental truncate.

**Need to re-import:**
1. 26 inventory orders from Notion pull
2. 88 estimates from QB PDF parse
3. Re-populate `selected_options` JSON on inventory orders for Equipment Match scoring

---

## [2026-03-29] — Contract Name & MOLY Contract # Added to Order Forms

**Category:** Status
**Project:** CATL Resources

Contract Name and MOLY Contract # fields were on the Order Detail page (click-to-edit after creation) but NEVER on NewOrder.tsx or EditOrder.tsx — the actual creation/editing forms. Added to both as a two-column row between Customer and Equipment sections. Both save to database on submit. EditOrder pre-fills from existing order data. This was requested "for the 10th time" — Lovable kept dropping the fields on incremental prompts.

---

## [2026-03-29] — Dashboard Search Bar Added

**Category:** Status
**Project:** CATL Resources

Global search bar on the dashboard, right below the header. Searches across orders (contract name, MOLY #, build shorthand), estimates (estimate number, QB doc number), and customers (name, email, phone). Debounced 300ms, triggers at 2+ characters. Results grouped by type in a dropdown.

---

## [2026-03-29] — Estimate Delete Functionality Added

**Category:** Status
**Project:** CATL Resources

Red trash icon on each estimate row in the Estimates page. Confirmation dialog shows estimate number, model name, and price before deleting. Also added estimate_number and qb_doc_number to the search filter on the Estimates page.

---

## [2026-03-29] — QB ItemRef Requires Numeric value Field

**Category:** Lesson
**Project:** CATL Resources

The single biggest QB integration fix this session. QB `ItemRef` needs `{ value: "1384", name: "Item Name" }`. Sending `{ name: "Item Name" }` alone makes QB treat the line as "documentation" and fall back to the default Services item (ID=1). This is why every estimate and PO showed as a single "Services" lump sum.

Fix: Created `qb-sync-item-ids` utility function that fetches all 613 QB items, matches by FullyQualifiedName to our `base_models.qb_item_name` and `model_options.qb_item_name`, and writes the numeric `qb_item_id` back. 27/27 base models and 72/72 options now have IDs. The Linn 12ft Panel was the one miss — QB had it as a top-level item (`LINN Catch Panel - 12'`, ID 1333) not under `Livestock Equipment:Linn`. Fixed manually.

---

## [2026-03-29] — Claude Code Evaluating QB API Integration

**Category:** Status
**Project:** CATL Resources

Chandy is having Claude Code evaluate the QB estimate and PO edge functions against the actual Intuit API docs. The functions work structurally but have been through 30+ versions due to the Lovable overwrite cycle. A clean evaluation against the API spec will identify any remaining gaps.

Current edge function versions deployed:
- `qb-push-estimate` v37 — returns 200 on errors for frontend visibility
- `qb-push-po` v15 — individual line items at cost with ItemRef value+name
- `send-estimate` v34 — sends from tim@catlresources.com with line items

---

---

## [2026-03-29] — PAIN POINT: No Document Visibility or Comparison

**Category:** Blocker
**Project:** CATL Resources

**The core problem:** The biggest risk in CATL's business is a mismatch between what the customer agreed to, what got ordered from the manufacturer, what the manufacturer actually built, and what the customer gets billed. Right now there is zero visibility into this chain inside the app.

**The document chain for a single deal:**
1. **CATL Estimate** (what Tim quoted the customer) — generated by this system
2. **Manufacturer order/contract** (what Moly thinks they're building) — PDF from Moly
3. **Manufacturer invoice** (what Moly built and is billing CATL) — PDF from email
4. **CATL customer invoice** (what Tim bills the customer) — generated from QB

All four need to be visible on the order, uploadable (PDF, photo, screenshot), and comparable against each other. The app currently has `order_documents` table and document fields on paperwork records, but there is NO UI for uploading, viewing, or comparing documents.

**What needs to be built:**
- Document upload (PDF, image) per order — either to Supabase Storage or linked from Drive
- Document viewer on the order detail page
- Side-by-side or diff-style comparison between the accepted estimate and the manufacturer order/invoice
- Visual flags when line items don't match between documents

---

## [2026-03-29] — PAIN POINT: No "Accepted Estimate" Designation

**Category:** Blocker
**Project:** CATL Resources

**The problem:** A customer may receive 2-3 estimate versions with different options and prices. They choose one. That chosen version needs to be clearly marked as THE accepted estimate. Everything downstream — the manufacturer order, the QB invoice, the document comparison — should reference that specific version.

**Current state:** Estimates have `is_current` (boolean) and `status` (open/sent/approved) fields, but there's no hard "this is the one the customer accepted" flag that locks it and makes it the reference point. The `approved` status exists but isn't enforced as the anchor for the whole order.

**What needs to happen:**
- "Customer accepted this estimate" action that sets a definitive status
- Accepted estimate becomes the baseline for all comparisons
- When converting to order, the accepted estimate's line items are what get sent to the manufacturer
- Any deviation between the accepted estimate and what actually gets ordered should be flagged


---

## [2026-03-29] — PAIN POINT: Redundant Data Entry Across 5+ Systems

**Category:** Blocker
**Project:** CATL Resources

**The problem:** Tim enters the same chute configuration and order information into multiple systems independently. Nothing flows from one to the next automatically. The app is supposed to eliminate this but currently adds to it.

**The redundancy chain for a single deal:**
1. **Write it down** — Tim takes notes during the phone call
2. **Enter in CATL app** — configurator to build the estimate
3. **Enter in QuickBooks** — estimate with the same line items (partially automated but broken)
4. **Enter in Moly portal** — re-enter the entire chute config to place the order
5. **Save documents** — manually download/organize PDFs from email into Drive
6. **Write email** — re-type the build details to send to customer
7. **Phone call follow-up** — re-explain everything verbally

**What the app SHOULD do (the vision):**
- Tim enters the config ONCE in the CATL app
- App pushes to QuickBooks (estimate at retail, PO at cost) — automated
- App generates customer-facing email with line items — automated
- App pre-fills or links to Moly portal — semi-automated
- App captures documents from Gmail automatically — built but not deployed
- App logs communications — not built at all

**Current automation state:**
- QB estimate push: broken (returns errors, still shows as lump Services)
- QB PO push: was broken (ItemRef missing), just fixed with item IDs, untested
- Email estimate: works as of today (sends from tim@catlresources.com)
- Moly portal: button exists that opens the portal URL, but no pre-fill
- Gmail scan: built but never run in production
- Notion sync: not needed if app replaces Notion entirely
- Communication logging: nothing built

---

## [2026-03-29] — PAIN POINT: No Communication Capture (Email, Phone, Text)

**Category:** Blocker
**Project:** CATL Resources

**The problem:** Conversations with customers and manufacturers happen across Gmail, phone calls, and text messages. None of this is captured in the app. When Tim needs to recall what was discussed or promised, he's searching through Gmail, scrolling through texts, or relying on memory.

**What's needed:**

**Email capture:**
- Pull relevant email threads from Tim's Gmail into the order timeline
- Match emails to orders by customer name, contract number, or email address
- Show email content inline on the order (not just "an email was sent")
- Both inbound and outbound — full conversation thread

**Phone call logging:**
- Auto-transcribe calls and pull key details (what was discussed, what was agreed to)
- Attach transcription to the order as a timeline event
- Ideal: Tim talks into his phone after a call, voice memo gets transcribed and logged
- Minimum viable: voice-to-text note that attaches to the order

**Text messages:**
- Harder to automate, but at minimum a way to paste/screenshot texts into the order
- Nice to have: iMessage or SMS integration that pulls texts by contact

**The goal:** Open any order and see the complete conversation history — every email, every call summary, every text — alongside the paperwork and status updates. A full story of the deal.

**Technical approaches to evaluate:**
- Gmail API (already connected for document scanning) — extend to pull email threads per customer/order
- Deepgram or Whisper for call transcription (Deepgram was previously preferred for background noise handling — see ChuteSide decision)
- Voice memo → transcription → AI summary → timeline entry (most practical for phone calls)
- Text capture likely manual (paste/screenshot) unless we build a dedicated SMS integration


---

## [2026-03-29] — PRIORITY DECISION: Document Visibility Is #1

**Category:** Decision
**Project:** CATL Resources

**Chandy's directive:** Being able to visually see that a document is attached, view it, and know it's linked to Google Drive is the top priority. Above QB integration, above communication capture, above everything else.

**The principle:** Google Drive is the paper trail. The app doesn't store files — it links to them in Drive where they're organized by manufacturer and year. The app's job is to:
1. Show clearly on every order which documents exist (green check / empty state)
2. Let Tim click to view any document (opens Drive link)
3. Let Tim attach a document (paste a Drive link, or upload and auto-save to Drive)
4. Organize everything in Drive folders by the convention: `Contract {MOLY contract number} – {contract name}`

**Revised priority order (agreed 2026-03-29):**
1. **Document visibility & Google Drive linking** — see, attach, view documents on every order
2. **QB integration working reliably** — estimates and POs with proper line items
3. **Redundant data entry reduction** — enter once, push everywhere
4. **Accepted estimate designation** — lock the version the customer agreed to
5. **Document comparison** — side-by-side check across the document chain
6. **Communication capture** — email threads, call transcription, text logging

**Google Drive folder structure (already mapped):**
- SILENCER 2025: `1GW2IZELTNmBNup9qdoKZqdBnDc6Z-Mn6`
- SILENCER 2026: `1XbMvfvbnR0PgOUeXqY0JCuHwqBwgOxrX`
- DANIELS 2025: `1MevH9MCkq15jxRcIsKlztb6bUCI_H8si`
- Daniels 2026: `1vXPiyREiR1Bwvuy8SJKRndJUSVyHY592`
- RAWHIDE Portable Corrals: `1V8WzsJapJuwzg3GEmIhqqn2gt9uHN7c7` (all years)
- MJE Livestock Equipment: `1oX4G4SMtRgYivBIVDv_AlvNyQEJ9MsXZ` (all years)
- CALF TABLES 2026: `1nXSDfWPXQY-Bs54tvsQjTfQiDGQfil31`

**Per-order folders:** Each order gets its own subfolder in the manufacturer's year folder. Naming convention: `Contract {MOLY contract number} – {contract name}`


---

## [2026-03-29] — Document Visibility Built and Deployed

**Category:** Milestone
**Project:** CATL Resources

Built the #1 priority feature — document visibility on every order. Three pieces:

**1. OverviewTab — Drive & Document Summary Section:**
- "Open Drive Folder" button (teal) when a Drive URL is linked
- "Link Drive Folder" button when no URL exists — paste a Drive URL, auto-extracts folder ID
- Document summary pills showing count by type (green check + "2 Invoices", "1 Sales Order", etc.)
- Empty state directs user to Documents tab

**2. DocumentsTab — Full Rewrite:**
- "Add Document" form: title, type dropdown (Invoice/Sales Order/Estimate/Contract/Correspondence/Photo/Other), Drive URL, optional notes
- Each document shows: type badge, title, description, source (Gmail scan vs manual), date
- File type icons (PDF=red, Image=purple, generic=gray)
- "Open" button links to the Drive file
- Delete with confirmation (notes that the Drive file itself is unaffected)
- Drive Folder shortcut button in header
- Gmail Scan button preserved from original
- Document count badge in header

**3. Order Cards — Doc Count Indicator:**
- Footer shows green "3 docs" pill when documents exist
- Shows red "No docs" pill when empty
- Instant visual scan across all orders to see which ones have paperwork attached

**What this does NOT yet do (future work):**
- Side-by-side document comparison
- PDF preview inline (currently opens in new tab via Drive link)
- Auto-create Drive subfolder per order
- Parse PDF content for spec matching

---

## [2026-03-29] — QB Full Sync Built (Customers + Items + Prices)

**Category:** Milestone
**Project:** CATL Resources

**Decision:** QuickBooks is the master for customers, item names, and pricing. The app never overrides QB — it pulls from QB and updates its own data.

**What was built:**
1. `qb-sync-items` edge function (v1) — fetches all QB items, matches by `qb_item_id`, updates `retail_price` from QB `UnitPrice`, `cost_price` from QB `PurchaseCost`, and `qb_item_name` if QB renamed it. Returns detailed change log.
2. Settings page now has three sync buttons:
   - **Sync Customers** — paginated full sync (500/page, loops until done)
   - **Sync Items & Prices** — syncs all base_models and model_options against QB
   - **Sync Everything** (gold button) — runs both in sequence
3. Results panel shows exactly what changed: "Ranch Model: retail $12,718 → $13,200" etc.

**How it works:**
- QB `UnitPrice` = our `retail_price` (what the customer pays)
- QB `PurchaseCost` = our `cost_price` (what we pay the manufacturer)
- QB `FullyQualifiedName` = our `qb_item_name` (the item name path)
- Matching is by `qb_item_id` (numeric QB ID) — never by name
- If an item in our system has no `qb_item_id`, it's flagged as "not found in QB"

**Existing customer sync (qb-sync-customers v4):** Already did upsert on `qb_customer_id`. Updated the Settings UI to paginate through all pages automatically instead of requiring manual page-by-page calls.


---

## [2026-03-29] — ARCHITECTURE DECISION: Frozen Snapshots + QB as Accounting System of Record

**Category:** Decision
**Project:** CATL Resources

**This is the most important architectural decision in the entire system.**

### The Two Systems, Two Jobs Principle

| System | Job | What it owns |
|---|---|---|
| **CATL Equipment Manager** | Day-to-day workflow: quoting, ordering, tracking, documents, communications | Order status, document links, paperwork tracking, estimate versions, communications |
| **QuickBooks Online** | Accounting: official invoices, payments, tax records | Customer list (master), item catalog with current prices (master), invoices, payments |

### The Frozen Snapshot Rule

**When an estimate is created, the prices at that moment are frozen into the estimate record.** They never change, even if QB prices are updated later. Same for orders — the cost and retail prices are frozen when the order is placed.

- `estimates.line_items` (JSONB) — frozen snapshot of every line item with prices at quote time
- `estimates.total_price` — frozen total
- `orders.selected_options` (JSONB) — frozen snapshot with `cost_price_each` and `retail_price_each`
- `orders.customer_price`, `orders.our_cost`, `orders.subtotal` — all frozen at creation

**The QB price sync ONLY updates catalog tables:**
- `base_models.retail_price` and `base_models.cost_price` — used for NEW estimates
- `model_options.retail_price` and `model_options.cost_price` — used for NEW estimates
- **NEVER touches `orders` or `estimates` tables**

### The Data Flow

1. QB has current prices → sync to our catalog tables
2. Tim creates estimate → app reads CURRENT catalog prices → freezes them into estimate
3. Prices change in QB → Tim syncs → catalog updates → existing estimates untouched
4. Customer accepts → estimate converts to order → frozen prices carry forward
5. App pushes estimate/PO to QB → QB gets our frozen prices (not current catalog)
6. Tim creates invoice in QB when customer pays → QB is the final accounting record

### Why This Matters

A customer who got a quote at $14,957 in January and calls back in March to accept it expects to pay $14,957 — even if the price went up to $15,500 in February. The frozen snapshot ensures the estimate reflects the deal as it was quoted, not as it would be quoted today.

This also prevents the nightmare scenario of a price sync retroactively changing the total on 50 open estimates.


---

## [2026-03-29] — ARCHITECTURE DECISION: Complete QB Document Flow

**Category:** Decision
**Project:** CATL Resources

**This documents the full lifecycle of QB documents for a single deal.**

### The 6-Step Flow

**Step 1: ESTIMATE**
- Tim builds chute config in the app
- App pushes Estimate to QB at RETAIL prices (frozen at time of creation)
- Freight is included on the estimate from the start
- **App button:** "Push Estimate to QB"
- **QB document created:** Estimate

**Step 2: CUSTOMER ACCEPTS**
- Tim marks the specific estimate version as accepted in the app
- That version becomes the frozen baseline for everything downstream
- No QB action at this step — the estimate already exists in QB

**Step 3: PURCHASE ORDER**
- App creates PO at COST prices (what we pay Moly)
- One PO per chute/order — always 1:1
- **App button:** "Push PO to QB"
- **QB document created:** Purchase Order (vendor = manufacturer)

**Step 4: MOLY BUILDS IT**
- Moly sends their invoice as a PDF (lumped total, not itemized) via email
- This PDF gets uploaded/linked to the order in our app

**Step 5: MOLY INVOICE → BILL**
- App compares the Moly invoice total to our PO total
- **Key detail:** Moly invoice is LUMPED (one big number), our PO is ITEMIZED (base + each option)
- If totals match → App converts the QB PO to a QB Bill
- If totals DON'T match → flag for Tim to review the difference
- **App button:** "Convert PO to Bill"
- **QB action:** PO converts to Bill (QB supports this natively via the API)

**Step 6: CHUTE SHIPS → CUSTOMER INVOICE**
- Triggered when Tim marks the chute as "shipped from manufacturer"
- App converts the QB Estimate to a QB Invoice
- Customer now owes money
- **App button:** "Convert Estimate to Invoice"
- **QB action:** Estimate converts to Invoice (QB supports this natively via the API)

### The Four QB Action Buttons (on Order Detail page)

1. **Push Estimate to QB** — creates QB Estimate at retail prices (already built, needs fixing)
2. **Push PO to QB** — creates QB Purchase Order at cost prices (already built, needs fixing)
3. **Convert PO to Bill** — NOT YET BUILT — converts existing QB PO to Bill after Moly invoice matches
4. **Convert Estimate to Invoice** — NOT YET BUILT — converts existing QB Estimate to Invoice when chute ships

### What the App Stores for QB Tracking

On the `orders` table:
- `qb_estimate_id` — QB's internal ID for the estimate we pushed
- `qb_estimate_doc_number` — the estimate number in QB
- `qb_po_id` — QB's internal ID for the PO we pushed
- `qb_po_doc_number` — the PO number in QB
- Need to add: `qb_bill_id`, `qb_invoice_id` for tracking the converted documents

### Moly Invoice Comparison Logic

Since Moly invoices are lumped (single total) and our POs are itemized:
- The comparison is TOTAL vs TOTAL, not line-by-line
- Our PO total = sum of all cost_price line items + freight
- Moly invoice total = the single number on their PDF
- If match → green check, ready to convert to bill
- If mismatch → red flag with the dollar difference, Tim investigates


---

## [2026-03-29] — QB API Research: Convert PO→Bill and Estimate→Invoice

**Category:** Research
**Project:** CATL Resources

### 1. Convert PO to Bill (via API)

**QB does NOT have a "convert PO to Bill" endpoint.** Instead, you CREATE a new Bill and LINK it to the PO using `LinkedTxn`.

**How it works:**
- POST to `/v3/company/{realmId}/bill` to create a Bill
- In the Bill's `LinkedTxn` array, reference the PO: `{ "TxnId": "{qb_po_id}", "TxnType": "PurchaseOrder" }`
- Each Bill line that came from the PO must have a new `Line.Id` (or omit Id) — QB links the line to the PO
- The vendor (`VendorRef`) must match the PO's vendor
- Bill lines need `ItemBasedExpenseLineDetail` (for items) or `AccountBasedExpenseLineDetail` (for account-based)

**Key detail from Ballerina docs:** "When updating an existing Bill to link to a PurchaseOrder a new Line must be created. This behavior matches the QuickBooks UI as it does not allow the linking of an existing line, but rather a new line must be added to link the PurchaseOrder."

**Our approach:** Create a new Bill with:
- `VendorRef` matching the manufacturer
- `LinkedTxn` referencing the PO by `qb_po_id`
- Single line item with the Moly invoice total (since their invoice is lumped)
- Or copy the PO line items into the Bill (keeps it itemized)

### 2. Convert Estimate to Invoice (via API)

**QB does NOT have a "convert estimate to invoice" endpoint either.** You CREATE a new Invoice and LINK it to the Estimate using `LinkedTxn`.

**How it works:**
- POST to `/v3/company/{realmId}/invoice` to create an Invoice
- In the Invoice's `LinkedTxn` array, reference the Estimate: `{ "TxnId": "{qb_estimate_id}", "TxnType": "Estimate" }`
- Copy the line items from the estimate into the invoice
- The `CustomerRef` must match the estimate's customer
- Only one Estimate can be linked per Invoice
- Progress Invoicing (partial invoicing from estimate) is supported but we don't need it — we invoice the full estimate

**Our approach:** Create a new Invoice with:
- `CustomerRef` from the order's customer QB ID
- `LinkedTxn` referencing the Estimate by `qb_estimate_id`
- Line items copied from our frozen estimate `line_items` JSONB
- Each line with `ItemRef: { value, name }` using the QB item IDs we already have

### Important Notes
- Both operations are CREATE (POST), not UPDATE — we're creating new QB objects linked to existing ones
- We need to store the resulting `qb_bill_id` and `qb_invoice_id` on our orders table (columns already exist)
- The Estimate status in QB changes to "Closed" automatically when fully invoiced
- The PO status in QB changes to "Closed" when a Bill is linked that covers the full amount

---

## [2026-09-01] — submit-lead Edge Function + web_leads Table (LIVE, merged PR #4)

**Category:** Milestone
**Project:** CATL Resources

One shared public Supabase edge function `submit-lead` (CRLE `dubzwbfqlwhkpmpuejsy`, `verify_jwt=false`) now backs BOTH the website contact form and the chute configurator/estimator. Deployed to CRLE and merged to `main` via PR #4 (merge commit `78136aa`).

- Saves every submission to a new `public.web_leads` table (status `new`, RLS enabled, authenticated users read, function writes via service role, `created_at desc` index).
- Then emails Tim via Resend from `tim@catlresources.com` with `reply_to` = the customer, so Reply goes straight to them.
- Always returns HTTP 200 with a `success` flag (matches the repo convention so the site shows a real message). The lead is saved BEFORE the email, so a Resend failure never loses it — the `emailed` flag just stays false.
- `source` field distinguishes the front ends. Shipped with `contact_form` (default) + `configurator`; the originally-specced `parts_order` source is NOT yet distinctly wired.
- Endpoint: `https://dubzwbfqlwhkpmpuejsy.supabase.co/functions/v1/submit-lead`

---

## [2026-09-01] — Silencer 2026 Price-List Catalog Sync (merged PR #4)

**Category:** Milestone
**Project:** CATL Resources

Reconciled the QuickBooks-reconciled Silencer Combined Price List 2026 against the live `model_options` catalog so the configurator matches the official list per model. Applied to CRLE and merged to `main` via PR #4. Catalog-only — no QuickBooks writes, `base_models` unchanged (the referenced QB items already exist in QB; only `qb_item_id` pointers + option rows changed).

- **3 stale QB-link fixes:** De-Horner (qb 312→1324); Heavy Yoke Extended ($4,100/qb739 → $6,427/qb1545); 12HP Gas Closed Center ($3,748/qb912 → $5,422/qb1546).
- **9 new per-model options:** squeeze variants (Ranch-Wide qb801, Std-Width Xtra qb1454, MAXX qb665); Gas 5.5HP qb111; bundled scales (TruTest-Platform-w/S3 qb1547, Weigh-Tronix-Platform-w/640 qb1548); Tilt Stand-Alone Rear Gate qb1516, Leg Restraint qb1520, Calf Puller qb1549.
- **Full 26-row per-model `model_restriction` lockdown** so each model shows exactly the list's option set.
- New versioned artifact `src/data/price-list-2026.json` (9 models, all options, QB ids). New options' `cost_price` set at the prevailing 20% margin (cost = retail × 0.8), flagged `verify` in `notes`.
- **Verified:** 83 options total; squeeze resolves to exactly 1 per model; carrier/power/scale counts per model match the list + preserved extras.

---

## [2026-09-01] — Configurator Reads model_restriction, NOT the Junction Table

**Category:** Lesson
**Project:** CATL Resources

Per-model option availability (which options appear on which Silencer model) is enforced through the `model_options.model_restriction` column — that is the field the equipment configurator actually reads. The `model_option_availability` junction table is effectively dead code: the configurator does not read it. Deliver any per-model show/hide via `model_restriction`. This is why the 2026 price-list per-model lockdown was implemented as 26 `model_restriction` updates rather than junction rows.

---

## [2026-09-01] — Open: Per-Model $0 Pricing Not Represented

**Category:** Blocker
**Project:** CATL Resources

The 2026 price list makes some options free on specific models (e.g. Additional Neck Access = $0 on Commercial Pro). This is NOT represented in the sync: the configurator reads `model_restriction` (show/hide) plus a single option price — it has no per-model price override. Representing per-model `$0` (or per-model prices generally) requires a CODE change: a per-model price map or a model-option price-override table wired into the configurator/estimator. Deferred and noted, not faked — the "$0-per-model configurator enhancement" left on the shelf.

Also open: wire the `parts_order` source into `submit-lead` when the parts website flow is built.
