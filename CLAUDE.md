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
| Typecheck | `npm run typecheck` | `tsc -p tsconfig.app.json --noEmit` (never bare `tsc --noEmit`: the root tsconfig is references-only and checks zero files) |
| Lint | `npm run lint` | Ratchet: CI fails only if the error count rises above `.lint-baseline`. Lower that number whenever you clean some up |
| Tests | `npm test` | vitest, jsdom. Only the scaffold placeholder test exists; the 54 edge functions have no tests |
| Build | `npm run build` | `vite build` |

Non-negotiables:

- Fresh container: `npm ci` before anything else.
- Never merge a PR with a red check. Never push straight to the default branch.
- The PR body uses the four headings in `.github/pull_request_template.md`. CI fails the PR without them.
- A new check is proven by planting a bug and watching it go red before it is trusted.
- Every Supabase call checks `error` before touching `data`. A `catch` that swallows has a comment saying why.
- Merging to main with a change under `supabase/functions/` deploys that function to PRODUCTION immediately (`.github/workflows/deploy-edge-functions.yml`). The PR gates are the only thing between a typo and the live robots.
- This repo is PUBLIC on GitHub and `.env` is committed (anon key only). Never commit a service-role key, a QuickBooks secret, or a customer's data.
- Error monitoring: the Sentry loader lives inline in `src/main.tsx` (inert until `VITE_SENTRY_DSN` is set in Vercel). Do not remove it. Edge functions still only `console.error`; a heartbeat/alert for the fleet is a queued item.

## Structural facts
- Edge functions are Deno on Supabase, source under `supabase/functions/<slug>/`.
- **Lovable overwrites edge functions on every deploy** — it redeploys cached
  versions of ALL functions when any frontend change ships. Always commit the
  correct source to `supabase/functions/*/index.ts`; never leave a fix live-only.
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
