-- web_leads: single inbox for website contact-form and chute-configurator submissions.
-- Filled by the `submit-lead` edge function (service role, bypasses RLS).
-- `source` distinguishes the two front ends; `status` is the don't-miss-anyone safety net.
create table if not exists public.web_leads (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  source             text not null default 'contact_form',  -- 'contact_form' | 'configurator'
  name               text not null,
  phone              text,
  email              text,
  state              text,
  herd_size          integer,
  equipment_interest text,        -- e.g. "Silencer chute" or which product line
  message            text,        -- free-text from the contact form
  build_json         jsonb,       -- the full configurator selection (null for contact form)
  estimated_total    numeric,     -- the configurator total (null for contact form)
  status             text not null default 'new',  -- new | contacted | quoted | won | lost
  emailed            boolean not null default false -- did Tim's email actually send
);

-- Newest-first listing in the Equipment Manager app.
create index if not exists web_leads_created_at_idx on public.web_leads (created_at desc);

-- Lock the table down: only signed-in app users can read it; the edge function writes
-- with the service key, which bypasses RLS.
alter table public.web_leads enable row level security;

drop policy if exists "authenticated can read leads" on public.web_leads;
create policy "authenticated can read leads"
  on public.web_leads for select
  to authenticated
  using (true);
