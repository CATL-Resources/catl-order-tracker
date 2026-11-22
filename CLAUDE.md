# CLAUDE.md — catl-order-tracker (CRLE robot fleet)

Operating rulebook for the edge-function fleet behind the CRLE Supabase project
(`dubzwbfqlwhkpmpuejsy`). Keep it LEAN: rules and structural facts only. Deeper
history lives in `project-memory.md` / `CATL-PROJECT-MEMORY.md`.

## Engineering standards (every session, every PR)

Full rules, and the definition of done: @docs/ENGINEERING-STANDARDS.md

Commands for this repo. All of these run automatically in GitHub Actions on every
PR and every push to the default branch (`.github/workflows/ci.yml`); a red check blocks the merge.

| Gate | Command | Note |
|---|---|---|
| Typecheck | `npm run typecheck` | `tsc -p tsconfig.app.json --noEmit` (never bare `tsc --noEmit`: the root tsconfig is references-only and checks zero files). Turning it on (2026-09-02) found 4 real type errors: `OverviewTab.tsx` passes `customer_id` where the type forbids it, and `Memos.tsx` reads `.notes` three times on a `Memo` type that has no `notes` field. Ratchet: CI fails only if the count rises above `.typecheck-baseline` (4). Fix them first when touching those screens. Google Maps types are referenced from `src/types/google-maps.d.ts`; do not delete it |
| Lint | `npm run lint` | Ratchet: CI fails only if the error count rises above `.lint-baseline` (668 pre-existing, almost all `no-explicit-any`). Lower that number whenever you clean some up |
| Tests | `npm test` | vitest, jsdom. Only the scaffold placeholder test exists; the 55 edge functions have no tests |
| Build | `npm run build` | `vite build` |

Non-negotiables:

- Fresh container: `npm ci` before anything else.
- Never merge a PR with a red check. Never push straight to the default branch.
- The PR body uses the four headings in `.github/pull_request_template.md`. CI fails the PR without them.
- A new check is proven by planting a bug and watching it go red before it is trusted.
- Every Supabase call checks `error` before touching `data`. A `catch` that swallows has a comment saying why.
- Merging to main with a change under `supabase/functions/` deploys that function to PRODUCTION immediately (`.github/workflows/deploy-edge-functions.yml`). The PR gates are the only thing between a typo and the live robots.
- This repo is being made PRIVATE (Chandy's call 2026-09-02; until the switch is flipped in Settings it is still public). `.env` is committed (anon key only). Never commit a service-role key, a QuickBooks secret, or a customer's data.
- Error monitoring: the Sentry loader lives inline in `src/main.tsx` (inert until `VITE_SENTRY_DSN` is set in Vercel). Do not remove it. Fleet alarm (2026-11-21): `robot_health_run()` runs seven checks into `robot_heartbeats`, and the `robot-health-check` function emails equipment@catlresources.com every morning (pg_cron `robot-health-check-daily`, 13:10 UTC) only when a check fails. A new robot or pipeline gets a check added there in the same PR.

## Structural facts
- Edge functions are Deno on Supabase, source under `supabase/functions/<slug>/`.
- **Lovable is gone (finished 2026-11-21).** Its GitHub app is uninstalled, its
  project is deleted, and `.lovable/` and `lovable-tagger` are removed. The React
  app in `src/` is the retired first version and is hosted nowhere. Screens live
  in `CATL-Resources/catl-hub` (catlapp.com). Always commit the correct source to
  `supabase/functions/*/index.ts`; never leave a fix live-only.
- The deploy job publishes ONLY the functions whose folders changed in the merged
  commit, and stops with an error if it cannot tell. It never deploys everything.
- QuickBooks: the app's own sign-in lives in `qb_tokens` and is renewed daily by
  pg_cron `qb-refresh-token-daily` (09:17 UTC). It is separate from the QuickBooks
  connector inside Claude. The app may CREATE ESTIMATES in QuickBooks and nothing
  else (Chandy, 2026-11-21); estimates are sent, accepted, and invoiced in QuickBooks.
- Applying a migration through the Supabase connector: statements with DROP or
  REVOKE raise an approval prompt that times out when nobody is watching. Write
  them another way (an existence check, a guard inside the function) or expect to wait.
- Build plan and phase prompts: `EQUIPMENT-MANAGER-PLAN.md`.
- Schema changes go through migration files in `supabase/migrations/`, additive
  only; every data write follows rollback → guarded write → read-back.

## Calls & memos — canonical ownership (never violate)
- **`call_log` is canonical for calls; `voice_memos` is for memos only.** One
  recording must NEVER produce two transcripts.
- `drive-watch-memos` must never write a duplicate `voice_memos` row for a call —
  calls route to `call_log` only. The **idempotency guard stays** — a calls-only
  recording-key code check (memo filenames repeat, so they're keyed by
  `drive_file_id` instead) plus the DB unique index on
  `voice_memos(drive_file_id)`. Do not remove either layer.
- Storage reality: both calls and memos live in the `voice-memos` bucket (calls
  under the `calls/` prefix). The `call-recordings` bucket is unused. The intended
  long-term call owner is `process-call-recording`, but it is currently dormant —
  `drive-watch-memos` is the live call source. Do not make drive-watch-memos skip
  calls entirely until process-call-recording is reactivated, or calls stop
  landing in `call_log`.
