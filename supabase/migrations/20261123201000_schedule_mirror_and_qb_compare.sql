-- TITLE: Schedule The Notion Mirror And QuickBooks Comparison, And Add Them To The Daily Alarm
select cron.schedule('notion-mirror-every-15min', '*/15 * * * *', $c$
  select net.http_post(url := 'https://dubzwbfqlwhkpmpuejsy.supabase.co/functions/v1/notion-mirror',
    headers := jsonb_build_object('Content-Type','application/json'), body := '{}'::jsonb, timeout_milliseconds := 120000);
$c$);
select cron.schedule('qb-order-compare-hourly', '23 * * * *', $c$
  select net.http_post(url := 'https://dubzwbfqlwhkpmpuejsy.supabase.co/functions/v1/qb-order-compare',
    headers := jsonb_build_object('Content-Type','application/json'), body := '{}'::jsonb, timeout_milliseconds := 120000);
$c$);

-- Adds two checks (notion_mirror, qb_compare) to robot_health_run, just before the lead_emails check.
do $$
declare d text;
begin
  d := pg_get_functiondef('public.robot_health_run()'::regprocedure);
  d := replace(d, $x$    ('lead_emails', 'Website Lead Emails',$x$, $x$    ('notion_mirror', 'Notion Board Mirror',
      coalesce((select max(finished_at) from public.notion_mirror_runs where ok) > now() - interval '1 hour', false),
      'Last good copy from Notion: ' || coalesce(to_char((select max(finished_at) from public.notion_mirror_runs where ok) at time zone tz, fmt), 'never')
        || coalesce('. Last error: ' || (select error from public.notion_mirror_runs where ok is false order by id desc limit 1), ''),
      'The robot that copies Tim''s Notion Equipment board into the Hub has not finished a good run in an hour. If the error says NOTION_API_KEY, the Notion connection key is missing or was removed.'),
    ('qb_compare', 'QuickBooks Order Comparison',
      coalesce((select max(finished_at) from public.qb_compare_runs where ok) > now() - interval '3 hours', false),
      'Last good comparison: ' || coalesce(to_char((select max(finished_at) from public.qb_compare_runs where ok) at time zone tz, fmt), 'never'),
      'The hourly robot that checks orders against QuickBooks (invoiced, paid, Moly billed) has not finished in 3 hours. Check the QuickBooks sign-in.'),
    ('lead_emails', 'Website Lead Emails',$x$);
  execute d;
end $$;
