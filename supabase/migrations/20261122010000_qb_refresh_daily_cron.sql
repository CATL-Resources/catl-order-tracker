-- Keep the Equipment Manager's own QuickBooks sign-in alive.
-- The sign-in lapsed on 2026-11-14 because nothing renewed it. This job calls the
-- existing qb-refresh-token edge function once a day. Intuit hands back a fresh
-- refresh token on every call, so a daily call keeps the sign-in from ever aging out.
-- qb-refresh-token requires a JWT; the anon key below is the public key already
-- committed in .env, not a secret.
select cron.unschedule('qb-refresh-token-daily')
where exists (select 1 from cron.job where jobname = 'qb-refresh-token-daily');

select cron.schedule(
  'qb-refresh-token-daily',
  '17 9 * * *',
  $job$
  select net.http_post(
    url := 'https://dubzwbfqlwhkpmpuejsy.supabase.co/functions/v1/qb-refresh-token',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR1Ynp3YmZxbHdoa3BtcHVlanN5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2MTYwMjUsImV4cCI6MjA5MDE5MjAyNX0.XxzInie-IfWqyLiegkZl5zD3jx9w7F76mugjrIg53sU'
    ),
    body := '{}'::jsonb
  );
  $job$
);
