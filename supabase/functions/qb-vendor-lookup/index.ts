import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Retired 2026-07-06 per CRLE audit §6.5 — one-off vendor lookup script, no longer needed.
Deno.serve(async () => {
  return new Response(JSON.stringify({ status: "disabled", message: "Retired — one-off vendor lookup script" }), {
    headers: { "Content-Type": "application/json" }
  });
});
