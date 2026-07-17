# CLAUDE.md — catl-order-tracker (CRLE robot fleet)

Operating rulebook for the edge-function fleet behind the CRLE Supabase project
(`dubzwbfqlwhkpmpuejsy`). Keep it LEAN: rules and structural facts only. Deeper
history lives in `project-memory.md` / `CATL-PROJECT-MEMORY.md`.

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
  calls route to `call_log` only. The **recording-key idempotency guard stays**
  (code check against call_log/voice_memos + the DB unique index on
  `voice_memos.recording_key`). Do not remove either layer.
- Storage reality: both calls and memos live in the `voice-memos` bucket (calls
  under the `calls/` prefix). The `call-recordings` bucket is unused. The intended
  long-term call owner is `process-call-recording`, but it is currently dormant —
  `drive-watch-memos` is the live call source. Do not make drive-watch-memos skip
  calls entirely until process-call-recording is reactivated, or calls stop
  landing in `call_log`.
