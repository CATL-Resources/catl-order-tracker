import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Public, unauthenticated endpoint (verify_jwt: false) — the only door into
// freight_runs for an anonymous browser. RLS on every freight table stays
// authenticated-only; this function uses the service role internally and
// hand-assembles a narrow response. Never select("*") anywhere below, and
// never add a dollar figure, a rate, or a QuickBooks reference to the
// response — that's the whole point of this file.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    let token: string | null = null;
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      token = typeof body?.token === "string" ? body.token : null;
    } else {
      token = new URL(req.url).searchParams.get("token");
    }

    if (!token) return ok({ found: false });

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Run-level: carrier name, driver name/phone, pickup date, ETA — nothing else.
    const { data: run, error: runErr } = await supabase
      .from("freight_runs")
      .select("id, driver_name, driver_phone, pickup_date, estimated_arrival, carriers ( name )")
      .eq("share_token", token)
      .maybeSingle();

    if (runErr || !run) return ok({ found: false });

    const { data: stopRows, error: stopsErr } = await supabase
      .from("freight_run_stops")
      .select("id, stop_order, stop_type, customer_name, delivery_address, delivery_city, delivery_state, delivery_zip, delivery_phone, delivery_instructions, unloading_equipment")
      .eq("freight_run_id", run.id)
      .order("stop_order");
    if (stopsErr) return ok({ found: false });

    const { data: itemRows, error: itemsErr } = await supabase
      .from("freight_run_items")
      .select("stop_id, load_order, orders ( contract_number, base_models ( name ) )")
      .eq("freight_run_id", run.id)
      .order("load_order");
    if (itemsErr) return ok({ found: false });

    const itemsByStop = new Map<string, { contract_number: string | null; model_name: string | null }[]>();
    for (const it of itemRows ?? []) {
      if (!it.stop_id) continue;
      const list = itemsByStop.get(it.stop_id) ?? [];
      list.push({
        contract_number: it.orders?.contract_number ?? null,
        model_name: it.orders?.base_models?.name ?? null,
      });
      itemsByStop.set(it.stop_id, list);
    }

    const stops = (stopRows ?? []).map((s) => ({
      stop_order: s.stop_order,
      stop_type: s.stop_type,
      customer_name: s.customer_name,
      delivery_address: s.delivery_address,
      delivery_city: s.delivery_city,
      delivery_state: s.delivery_state,
      delivery_zip: s.delivery_zip,
      delivery_phone: s.delivery_phone,
      delivery_instructions: s.delivery_instructions,
      unloading_equipment: s.unloading_equipment,
      items: itemsByStop.get(s.id) ?? [],
    }));

    const mapsPoints = stops
      .map((s) => [s.delivery_address, s.delivery_city, s.delivery_state, s.delivery_zip].filter(Boolean).join(", ") || s.customer_name)
      .filter(Boolean);
    const maps_url = mapsPoints.length >= 2
      ? "https://www.google.com/maps/dir/" + mapsPoints.map((p) => encodeURIComponent(p as string)).join("/")
      : null;

    return ok({
      found: true,
      run: {
        carrier_name: run.carriers?.name ?? null,
        driver_name: run.driver_name,
        driver_phone: run.driver_phone,
        pickup_date: run.pickup_date,
        estimated_arrival: run.estimated_arrival,
      },
      stops,
      maps_url,
    });
  } catch (err) {
    // Never surface internals — the driver's page shows a plain message either way.
    console.error("freight-share error:", err);
    return ok({ found: false });
  }

  function ok(payload: Record<string, unknown>) {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
