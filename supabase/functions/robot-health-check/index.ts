// TITLE: Robot Alarm - Email CATL When A Background Job Goes Quiet
// Runs once a day from pg_cron (job robot-health-check-daily).
// Asks the database for the health checks (robot_health_run), and if any check is
// failing, emails equipment@catlresources.com in plain English. A green day sends nothing.
// Send {"test_alert": true} to force an email, which is how the alarm path is proven.
// Only ever emails CATL's own address. Always answers HTTP 200 with { success, ... }.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TO = ["equipment@catlresources.com"];
const FROM = "CATL Equipment Manager <website@catlresources.com>";

type Check = {
  check_key: string;
  label: string;
  ok: boolean;
  detail: string | null;
  how_to_fix: string | null;
  failing_since: string | null;
};

async function sendEmail(subject: string, text: string): Promise<{ ok: boolean; detail: string }> {
  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!resendKey) return { ok: false, detail: "RESEND_API_KEY is not set" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: TO, subject, text }),
  });
  const body = (await res.text()).slice(0, 300);
  return { ok: res.ok, detail: `Email service said ${res.status}: ${body}` };
}

Deno.serve(async (req: Request) => {
  const reply = (payload: Record<string, unknown>) => {
    if (payload.success === false) console.error("[robot-health-check] FAILED", JSON.stringify(payload));
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  try {
    const input = await req.json().catch(() => ({}));
    const testAlert = input?.test_alert === true;

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data, error } = await supabase.rpc("robot_health_run");

    if (error) {
      // The check itself could not run. That is an alarm too.
      const sent = await sendEmail(
        "BROKEN: The Equipment Manager Health Check Could Not Run",
        `The daily health check failed before it could look at anything.\n\nError: ${error.message}\n\nTell Claude: "the robot health check could not run."`,
      );
      return reply({ success: false, error: error.message, emailed: sent.ok, email_detail: sent.detail });
    }

    const checks = (data ?? []) as Check[];
    const failing = checks.filter((c) => !c.ok);

    if (failing.length === 0 && !testAlert) {
      console.log("[robot-health-check] all green", checks.length);
      return reply({ success: true, checks: checks.length, failing: 0, emailed: false });
    }

    const day = (iso: string | null) =>
      iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Denver", month: "short", day: "numeric" }) : "today";

    const failingText = failing.length
      ? failing.map((c) => `NOT WORKING: ${c.label}\n  ${c.detail ?? ""}\n  Failing since: ${day(c.failing_since)}\n  What to do: ${c.how_to_fix ?? "Tell Claude."}`).join("\n\n")
      : "Nothing is failing. This is a test of the alarm.";
    const okText = checks.filter((c) => c.ok).map((c) => `Working: ${c.label} (${c.detail ?? ""})`).join("\n");

    const subject = failing.length
      ? `BROKEN: ${failing.length} Equipment Manager Check${failing.length === 1 ? "" : "s"} Need Attention`
      : "TEST: Equipment Manager Alarm";
    const text = `${testAlert ? "This email was sent as a test of the alarm.\n\n" : ""}${failingText}\n\n${okText}\n\nThis check runs every morning. You get this email only when something is not working.`;

    const sent = await sendEmail(subject, text);
    if (!sent.ok) return reply({ success: false, error: sent.detail, failing: failing.length, emailed: false });

    console.log("[robot-health-check] alert sent", failing.length);
    return reply({ success: true, checks: checks.length, failing: failing.length, emailed: true, failing_keys: failing.map((c) => c.check_key) });
  } catch (err) {
    return reply({ success: false, error: String(err) });
  }
});
