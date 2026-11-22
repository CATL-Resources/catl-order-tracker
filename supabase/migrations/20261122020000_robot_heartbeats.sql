-- Robot alarms. One row per health check, refreshed by robot_health_run().
-- The robot-health-check edge function calls robot_health_run() once a day and
-- emails equipment@catlresources.com when any check is failing.
create table if not exists public.robot_heartbeats (
  check_key        text primary key,
  label            text not null,
  ok               boolean not null,
  detail           text,
  how_to_fix       text,
  last_checked_at  timestamptz not null default now(),
  last_ok_at       timestamptz,
  failing_since    timestamptz
);

alter table public.robot_heartbeats enable row level security;

drop policy if exists robot_heartbeats_read on public.robot_heartbeats;
create policy robot_heartbeats_read on public.robot_heartbeats
  for select to authenticated using (true);

create or replace function public.robot_health_run()
returns setof public.robot_heartbeats
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  fmt constant text := 'Mon DD, HH12:MI AM';
  tz  constant text := 'America/Denver';
  last_email   timestamptz := (select max(created_at) from public.gmail_inbox);
  last_call    timestamptz := (select max(created_at) from public.call_log);
  last_dwm     timestamptz := (select max(d.end_time) from cron.job j join cron.job_run_details d on d.jobid = j.jobid
                               where j.jobname = 'drive-watch-memos-every-5min' and d.status = 'succeeded');
  last_gscan   timestamptz := (select max(d.end_time) from cron.job j join cron.job_run_details d on d.jobid = j.jobid
                               where j.jobname = 'gmail-scan-every-15min' and d.status = 'succeeded');
  qb_renewed   timestamptz := (select max(updated_at) from public.qb_tokens);
  qb_expires   timestamptz := (select max(refresh_token_expires_at) from public.qb_tokens);
  stuck_leads  integer := (select count(*) from public.web_leads
                           where emailed is not true
                             and created_at < now() - interval '15 minutes'
                             and created_at > now() - interval '14 days');
begin
  return query
  with checks(check_key, label, ok, detail, how_to_fix) as (
    values
    ('gmail_scan', 'Email Scanner',
      coalesce(last_email > now() - interval '24 hours', false),
      'Last email saved: ' || coalesce(to_char(last_email at time zone tz, fmt), 'never'),
      'The robot that reads Tim''s Gmail has saved nothing in 24 hours. Check Tim''s Google sign-in and the gmail-scan robot.'),
    ('calls', 'Phone Call Recordings',
      coalesce(last_call > now() - interval '3 days', false),
      'Last call logged: ' || coalesce(to_char(last_call at time zone tz, fmt), 'never'),
      'No phone call has arrived in 3 days. On Tim''s phone, check that Cube ACR is recording and backing up to Google Drive.'),
    ('drive_watch_schedule', 'Call And Memo Robot Schedule',
      coalesce(last_dwm > now() - interval '30 minutes', false),
      'Last good run: ' || coalesce(to_char(last_dwm at time zone tz, fmt), 'never'),
      'The every-5-minutes job that checks Tim''s Drive has not finished a run in 30 minutes.'),
    ('gmail_scan_schedule', 'Email Scanner Schedule',
      coalesce(last_gscan > now() - interval '60 minutes', false),
      'Last good run: ' || coalesce(to_char(last_gscan at time zone tz, fmt), 'never'),
      'The every-15-minutes job that reads Tim''s Gmail has not finished a run in an hour.'),
    ('qb_renewal', 'QuickBooks Sign-In Renewal',
      coalesce(qb_renewed > now() - interval '36 hours', false),
      'Last renewed: ' || coalesce(to_char(qb_renewed at time zone tz, fmt), 'never'),
      'The daily QuickBooks renewal did not run. If this repeats, sign in again: https://dubzwbfqlwhkpmpuejsy.supabase.co/functions/v1/qb-auth-start'),
    ('qb_expiry', 'QuickBooks Sign-In Expiry',
      coalesce(qb_expires > now() + interval '14 days', false),
      'Sign-in is good until: ' || coalesce(to_char(qb_expires at time zone tz, 'Mon DD, YYYY'), 'not connected'),
      'The QuickBooks sign-in lapses within 14 days. Sign in again: https://dubzwbfqlwhkpmpuejsy.supabase.co/functions/v1/qb-auth-start'),
    ('lead_emails', 'Website Lead Emails',
      stuck_leads = 0,
      stuck_leads || ' website lead(s) saved but never emailed',
      'A website lead was saved but the email to equipment@ did not go out. Open the leads list and check the notify-web-lead robot.')
  )
  insert into public.robot_heartbeats as h
    (check_key, label, ok, detail, how_to_fix, last_checked_at, last_ok_at, failing_since)
  select c.check_key, c.label, c.ok, c.detail, c.how_to_fix, now(),
         case when c.ok then now() end,
         case when c.ok then null else now() end
  from checks c
  on conflict (check_key) do update set
    label = excluded.label,
    ok = excluded.ok,
    detail = excluded.detail,
    how_to_fix = excluded.how_to_fix,
    last_checked_at = now(),
    last_ok_at = case when excluded.ok then now() else h.last_ok_at end,
    failing_since = case when excluded.ok then null else coalesce(h.failing_since, now()) end
  returning h.*;
end;
$fn$;

revoke all on function public.robot_health_run() from public, anon;
grant execute on function public.robot_health_run() to authenticated, service_role;

-- Run the alarm every morning at 6:10 AM Mountain (13:10 UTC).
select cron.unschedule('robot-health-check-daily')
where exists (select 1 from cron.job where jobname = 'robot-health-check-daily');

select cron.schedule(
  'robot-health-check-daily',
  '10 13 * * *',
  $job$
  select net.http_post(
    url := 'https://dubzwbfqlwhkpmpuejsy.supabase.co/functions/v1/robot-health-check',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
  $job$
);
