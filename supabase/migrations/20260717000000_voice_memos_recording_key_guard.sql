-- Durable guard against duplicate call/memo transcripts (2026-07-17).
--
-- Background: drive-watch-memos used to write a voice_memos row for every call
-- in addition to the canonical call_log row, so one recording produced two
-- transcripts. The function now routes calls to call_log only and checks the
-- recording key before processing. This migration backs that with a DB-level
-- guarantee so no future code change can reintroduce the bug.
--
-- A recording's stable identity is its stored path minus the leading upload
-- timestamp — the same key the Hub's screen-side dedupe matches on:
--   regexp_replace(path, '^(calls|memos)/<ISO-ts>Z_', '')  ->  `${recordedBy}_${filename}`
--
-- ADDITIVE ONLY: one generated column + one partial unique index. Nothing is
-- dropped or retyped, and no existing row is modified.

ALTER TABLE public.voice_memos
  ADD COLUMN IF NOT EXISTS recording_key text
  GENERATED ALWAYS AS (
    regexp_replace(coalesce(audio_storage_path, ''), '^(calls|memos)/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]+Z_', '')
  ) STORED;

-- One voice_memos row per recording. Partial (skips rows with no audio path /
-- empty key) so hand-entered memos without audio are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_voice_memos_recording_key
  ON public.voice_memos (recording_key)
  WHERE audio_storage_path IS NOT NULL AND recording_key <> '';
