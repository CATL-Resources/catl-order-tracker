-- Search Console robot: run log, daily schedule, and two new robot-alarm checks.
create table if not exists public.gsc_pull_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean not null,
  rows_saved int not null default 0,
  note text,
  error text
);
alter table public.gsc_pull_runs enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='gsc_pull_runs' and policyname='gsc_pull_runs_staff_select') then
    create policy gsc_pull_runs_staff_select on public.gsc_pull_runs for select to authenticated using (auth.uid() is not null);
  end if;
end $$;

-- Daily at 14:37 UTC (7:37 AM Mountain), after Google has posted yesterday's numbers.
select cron.schedule('gsc-pull-daily', '37 14 * * *', $c$
  select net.http_post(url := 'https://dubzwbfqlwhkpmpuejsy.supabase.co/functions/v1/gsc-pull',
    headers := jsonb_build_object('Content-Type','application/json'), body := '{}'::jsonb, timeout_milliseconds := 120000);
$c$);

create or replace function public.robot_health_run()
 returns setof robot_heartbeats
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
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
  gsc_on       boolean := exists (select 1 from public.google_tokens_gsc where refresh_token is not null);
  gsc_last_ok  timestamptz := (select max(finished_at) from public.gsc_pull_runs where ok);
  gsc_last_err text := (select error from public.gsc_pull_runs where ok is false order by id desc limit 1);
  last_visit   timestamptz := (select max(at) from public.site_visits);
begin
  if coalesce(auth.role(), '') = 'anon' then
    raise exception 'robot_health_run is not available to signed-out callers';
  end if;

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
    ('notion_mirror', 'Notion Board Mirror',
      coalesce((select max(finished_at) from public.notion_mirror_runs where ok) > now() - interval '1 hour', false),
      'Last good copy from Notion: ' || coalesce(to_char((select max(finished_at) from public.notion_mirror_runs where ok) at time zone tz, fmt), 'never')
        || coalesce('. Last error: ' || (select error from public.notion_mirror_runs where ok is false order by id desc limit 1), ''),
      'The robot that copies Tim''s Notion Equipment board into the Hub has not finished a good run in an hour. If the error says NOTION_API_KEY, the Notion connection key is missing or was removed.'),
    ('qb_compare', 'QuickBooks Order Comparison',
      coalesce((select max(finished_at) from public.qb_compare_runs where ok) > now() - interval '3 hours', false),
      'Last good comparison: ' || coalesce(to_char((select max(finished_at) from public.qb_compare_runs where ok) at time zone tz, fmt), 'never'),
      'The hourly robot that checks orders against QuickBooks (invoiced, paid, Moly billed) has not finished in 3 hours. Check the QuickBooks sign-in.'),
    ('lead_emails', 'Website Lead Emails',
      stuck_leads = 0,
      stuck_leads || ' website lead(s) saved but never emailed',
      'A website lead was saved but the email to equipment@ did not go out. Open the leads list and check the notify-web-lead robot.'),
    ('gsc_pull', 'Google Search Console Pull',
      (not gsc_on) or coalesce(gsc_last_ok > now() - interval '36 hours', false),
      case when not gsc_on then 'Not connected yet (Hub > Website Analytics > Connect Google Search Console)'
           else 'Last good pull: ' || coalesce(to_char(gsc_last_ok at time zone tz, fmt), 'never') || coalesce('. Last error: ' || gsc_last_err, '') end,
      'The daily robot that copies Google search numbers into the Hub has not worked in 36 hours. If the error mentions sign-in, press Connect Google Search Console in Hub > Website Analytics again.'),
    ('site_visits', 'Website Visit Counter',
      now() < timestamptz '2026-11-27' or coalesce(last_visit > now() - interval '48 hours', false),
      'Last visit logged: ' || coalesce(to_char(last_visit at time zone tz, fmt), 'never'),
      'No visit to catlresources.com has been counted in 2 days. Either the site is down, the domain is not pointing at Vercel, or assets/track.js broke.')
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
$function$;
