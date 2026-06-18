import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  // Browsers send a preflight "OPTIONS" request first — answer it.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const {
      source = "contact_form",
      name,
      phone = null,
      email = null,
      state = null,
      herd_size = null,
      equipment_interest = null,
      message = null,
      build = null,            // configurator: { lines: [{name, price}], total }
      estimated_total = null,
    } = body ?? {};

    // Need at least a name and one way to reach them.
    if (!name || (!phone && !email)) {
      return ok({ success: false, error: "Missing name or contact info" });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // 1) Save the lead
    const { data: lead, error: insertError } = await supabase
      .from("web_leads")
      .insert({
        source, name, phone, email, state, herd_size,
        equipment_interest, message,
        build_json: build,
        estimated_total,
      })
      .select()
      .single();

    if (insertError) {
      return ok({ success: false, error: insertError.message });
    }

    // 2) Email Tim
    let emailed = false;
    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (resendKey) {
      const kind = source === "configurator"
        ? "Chute estimate request"
        : "Website quote request";
      const totalTag = estimated_total
        ? ` — ~$${Number(estimated_total).toLocaleString()}`
        : "";
      const buildLines = build?.lines
        ? build.lines
            .map((l: any) => `  - ${l.name}: $${Number(l.price).toLocaleString()}`)
            .join("\n")
        : "";

      const text =
`New ${kind} from the website.

Name: ${name}
Phone: ${phone ?? "-"}
Email: ${email ?? "-"}
State: ${state ?? "-"}
Herd size: ${herd_size ?? "-"}
Interested in: ${equipment_interest ?? "-"}
${message ? `\nMessage:\n${message}\n` : ""}${buildLines ? `\nBuild:\n${buildLines}\n\nEstimated total: $${Number(estimated_total).toLocaleString()}\n` : ""}
Lead saved (id ${lead.id}).`;

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "CATL Website <tim@catlresources.com>",
          to: ["tim@catlresources.com"],
          reply_to: email ? [email] : undefined, // Tim hits reply -> goes to the customer
          subject: `${kind}: ${name}${totalTag}`,
          text,
        }),
      });
      emailed = res.ok;
      if (emailed) {
        await supabase.from("web_leads").update({ emailed: true }).eq("id", lead.id);
      }
    }

    return ok({ success: true, id: lead.id, emailed });
  } catch (err) {
    return ok({ success: false, error: String(err) });
  }

  // Always return HTTP 200 — the frontend reads the success flag, not the status code.
  function ok(payload: Record<string, unknown>) {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
