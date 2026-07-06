import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Retired 2026-07-06 per CRLE audit §6.5 — one-off backfill script, no longer needed.
Deno.serve(async () => {
  return new Response(JSON.stringify({ status: "disabled", message: "Retired — one-off backfill script" }), {
    headers: { "Content-Type": "application/json" }
  });
});
