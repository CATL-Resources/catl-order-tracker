import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Retired 2026-07-06 per CRLE audit §6.6 — one-time backfill script hardcoded to a single order (44270), no longer needed.
Deno.serve(async () => {
  return new Response(JSON.stringify({ status: "disabled", message: "Retired — one-time backfill script for order 44270" }), {
    headers: { "Content-Type": "application/json" }
  });
});
