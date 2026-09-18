# CATL Resources Livestock Equipment Manager — Project Memory
> Last updated: 2026-09-01 (submit-lead + web_leads live; Silencer 2026 price-list catalog sync — both merged via PR #4)

## Project Basics
- **App**: Tracks livestock equipment from quote → order → build → delivery → freight
- **Stack**: React (Lovable) → GitHub `chandyolson/catl-order-tracker` → Supabase "CRLE" (`dubzwbfqlwhkpmpuejsy`)
- **Design System**: ChuteSide — cream #F5F5F0, navy #0E2646, teal #55BAAA, gold #F3D12A
- **Skill file**: `/mnt/skills/user/catl-equipment-ops/SKILL.md` — READ THIS FIRST every session
- **Last commit**: PR #4 merged into `main` — submit-lead + web_leads + Silencer 2026 price sync (merge `78136aa`)

## Nav (6 items)
Dashboard, Equipment, Leads, Freight, Customers, Settings

## Session Summary — 2026-09-01

### Website Leads — submit-lead Edge Function + web_leads Table (LIVE, merged PR #4)
- New public edge function `submit-lead` (CRLE `dubzwbfqlwhkpmpuejsy`, `verify_jwt=false`) backs BOTH the website contact form and the chute configurator/estimator.
- Every submission: (1) saves a row to new `public.web_leads` (status `new`, RLS on, service-role writes, `created_at desc` index), then (2) emails Tim via Resend from `tim@catlresources.com` with `reply_to` = customer.
- Always returns HTTP 200 with a `success` flag (repo convention). Lead is saved BEFORE the email, so a Resend failure never loses it (`emailed` stays false).
- `source` field distinguishes the front ends — ships with `contact_form` (default) + `configurator`. Originally-specced `parts_order` source NOT yet distinctly wired.
- Endpoint: `https://dubzwbfqlwhkpmpuejsy.supabase.co/functions/v1/submit-lead`

### Silencer 2026 Price-List Catalog Sync (applied to CRLE, merged PR #4)
- Reconciled the QB-reconciled Silencer Combined Price List 2026 against live `model_options`. Catalog-only — no QuickBooks writes, `base_models` unchanged.
- 3 stale QB-link fixes: De-Horner (qb 312→1324); Heavy Yoke Extended ($4,100/qb739 → $6,427/qb1545); 12HP Gas Closed Center ($3,748/qb912 → $5,422/qb1546).
- 9 new per-model options: squeeze variants (Ranch-Wide qb801, Std-Width Xtra qb1454, MAXX qb665); Gas 5.5HP qb111; bundled scales (TruTest-Platform-w/S3 qb1547, Weigh-Tronix-Platform-w/640 qb1548); Tilt Stand-Alone Rear Gate qb1516, Leg Restraint qb1520, Calf Puller qb1549.
- Full 26-row per-model `model_restriction` lockdown so each model shows exactly the list's option set.
- New artifact `src/data/price-list-2026.json` (9 models, all options, QB ids). New options' `cost_price` at 20% margin (cost = retail × 0.8), flagged `verify` in notes.
- Verified: 83 options total; squeeze resolves to exactly 1 per model; carrier/power/scale counts per model match the list + preserved extras.

### KEY LESSON — configurator availability lives in `model_restriction`
- Per-model option availability is enforced via the `model_options.model_restriction` column — the field the configurator actually reads. The `model_option_availability` junction table is dead code (not read). Deliver per-model show/hide via `model_restriction`.

### Live-App Impact & Open Items
- ⚠️ The `model_restriction` lockdown changes the LIVE configurator — options not on a model's list are now hidden on that model (explicit "full per-model lockdown" choice). Non-list options (CATL mods, Extended-Chute machinery, controls helpers, scale components) left available on all models.
- OPEN: per-model `$0` pricing (e.g. free Additional Neck Access on C PRO) not represented — configurator reads `model_restriction` + a single price, no per-model override. Needs a code change (per-model price map / override table). Deferred, not faked.
- OPEN: wire the `parts_order` source into `submit-lead` when the parts website flow is built.

## Session Summary — 2026-04-04

### Page Consolidation
- Equipment: merged Orders+Inventory+Production (tabs, 3 views)
- Leads: replaced Estimates (temperature pipeline)
- Dashboard: absorbs Tasks (inline create) + Voice Memos
- 8 dead pages removed, old URLs redirect

### Freight System — COMPLETE
- carriers table (external truckers + CATL vehicles, phone/email/vehicle)
- freight_runs table (start/end locations, status pipeline, miles, cost, share_token)
- freight_run_stops table (pickup/delivery types, auto-fill from customer, fully overridable)
- Known locations: CATL Wall SD, Moly Lorraine KS, Daniels Ainsworth NE, MJE El Dorado KS
- **"Deliver to CATL" quick button** — one tap creates delivery stop to yard
- **CATL as pickup location** — for outbound runs from yard to customer
- Printable run sheet with loading order callout
- Share button copies public URL for driver

### Driver Share Page — UPDATED
- Now shows Start → Pickups → Deliveries → End matching Freight page
- Route summary, loading order, tap-to-call, Google Maps links

### Status Change — FIXED
- Tappable StatusDropdown on Order Detail header
- Saves instantly to DB, logs timeline entry
- 7 statuses: Estimate → Purchase Order → Order Pending → Building → Ready → Delivered → Closed

### Document Chain — MAJOR FIXES
- Browse button on EVERY slot (filled or empty)
- link-document-to-slot v5: auto-creates slot if missing
- drive-scan-documents v7: QB prefix matching, signed/contract patterns
- qb-find-estimates v3: searches all 4 QB doc types by DocNumber
- qb-push-po v56: returns 200 on errors (shows actual error message)
- Duplicate slots cleaned, unique constraint added
- Old moly_* types renamed to mfg_*
- All orders backfilled to 9 standard slots
- Batch scan + QB search run across all orders

### Other Features
- Duplicate Order (⋮ → Duplicate Specs)
- Ready for Pickup pill (was "Overdue")
- Orange Sheet (per-order receiving checklist)

### Doc Chain Auto-Link Results
- 22 orders with customers: 18 estimates, 20 POs, 10 invoices auto-linked from QB
- 0 bills matched (QB DocNumber search issue — needs debug)
- 56% of doc chain slots filled automatically across Drive-linked orders

## Doc Chain Slot Types (9 total)
catl_estimate, approved_estimate, catl_purchase_order, mfg_web_order,
mfg_sales_order, signed_sales_order, mfg_invoice, qb_bill, catl_customer_invoice

## What's Next
1. **QB Bill matching** — DocNumber search returns nothing. Try different QB query approach.
2. **CATL Assistant rethink** — what should it focus on?
3. **Mass select/bulk edit** on Equipment list
4. **Orange Sheet expansion** based on Tim feedback
5. **Route map** on freight runs

## Known Issues
1. QB Bill search not finding bills by DocNumber
2. Google Drive intermittently blocked from some edge functions
3. 61 options missing IDs (Daniels/Rawhide catalog)
4. Duplicate order record for 44277 (from Duplicate Specs — needs cleanup)

## Edge Functions Updated This Session
- drive-scan-documents v7, link-document-to-slot v5, qb-find-estimates v3, qb-push-po v56

## DB Changes This Session
- Unique constraint: idx_unique_order_slot (order_id, slot_type)
- All slots backfilled to 9 types per order
- Old moly_* slot types renamed to mfg_*
- freight tables: carriers, freight_runs, freight_run_stops
