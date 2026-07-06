import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async () => {
  return new Response(JSON.stringify({ status: 'ok', message: 'Diagnostics disabled' }), {
    headers: { 'Content-Type': 'application/json' }
  });
});
