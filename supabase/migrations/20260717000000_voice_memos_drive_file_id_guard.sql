-- Durable guard: at most one voice_memos row per Drive recording (2026-07-17).
--
-- Background: drive-watch-memos used to write a voice_memos row for every call
-- in addition to the canonical call_log row. The function now routes calls to
-- call_log only; this index is the database-level backstop so re-processing a
-- Drive file can never create a second voice_memos row.
--
-- Why drive_file_id (not a filename-derived key): the phone's voice recorder
-- reuses generic names like "My recording 2.mp3", so filename is NOT unique per
-- recording — two distinct memos legitimately share it. drive_file_id is the
-- unique identity of a Drive recording and matches the function's existing
-- drive_file_id/ledger dedup. Verified 0 collisions across current rows.
--
-- ADDITIVE ONLY: one partial unique index. Nothing dropped, retyped, or updated.
-- ROLLBACK: DROP INDEX IF EXISTS public.uniq_voice_memos_drive_file_id;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_voice_memos_drive_file_id
  ON public.voice_memos (drive_file_id)
  WHERE drive_file_id IS NOT NULL;
