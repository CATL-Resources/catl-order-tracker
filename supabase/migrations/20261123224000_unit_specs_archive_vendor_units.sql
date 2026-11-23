-- TITLE: Unit Specs From QuickBooks Lines, Archive Button Fields, Daniels And Rawhide Units From QuickBooks POs
-- Paste all of this into Supabase > SQL Editor (project dubzwbfqlwhkpmpuejsy) and click Run.
-- Safe to run more than once. It never changes QuickBooks, Notion, customers, or existing orders' data.

alter table public.qb_docs add column if not exists party_id text;

create table if not exists public.qb_doc_lines (
  qb_type text not null,
  qb_id text not null,
  line_no integer not null,
  item_id text,
  item_name text,
  description text,
  qty numeric,
  unit_price numeric,
  amount numeric,
  serials text[] not null default '{}',
  primary key (qb_type, qb_id, line_no),
  foreign key (qb_type, qb_id) references public.qb_docs(qb_type, qb_id) on delete cascade
);
comment on table public.qb_doc_lines is 'Line items of the QuickBooks documents in qb_docs. Read-only copy.';
alter table public.qb_doc_lines enable row level security;
drop policy if exists qb_doc_lines_read on public.qb_doc_lines;
create policy qb_doc_lines_read on public.qb_doc_lines for select to authenticated using (true);

create or replace function public.qb_docs_save(p_docs jsonb)
returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare n int;
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then raise exception 'robot only'; end if;
  insert into qb_docs as q (qb_type, qb_id, doc_number, txn_date, party_name, party_id, total, balance, keys_contract, keys_serial, keys_catl, fetched_at)
  select d->>'qb_type', d->>'qb_id', d->>'doc_number', (d->>'txn_date')::date, d->>'party_name', d->>'party_id',
         (d->>'total')::numeric, (d->>'balance')::numeric,
         coalesce(array(select jsonb_array_elements_text(d->'keys_contract')), '{}'),
         coalesce(array(select jsonb_array_elements_text(d->'keys_serial')), '{}'),
         coalesce(array(select jsonb_array_elements_text(d->'keys_catl')), '{}'),
         now()
  from jsonb_array_elements(p_docs) d
  on conflict (qb_type, qb_id) do update set
    doc_number = excluded.doc_number, txn_date = excluded.txn_date, party_name = excluded.party_name,
    party_id = excluded.party_id, total = excluded.total, balance = excluded.balance,
    keys_contract = excluded.keys_contract, keys_serial = excluded.keys_serial, keys_catl = excluded.keys_catl, fetched_at = now();
  get diagnostics n = row_count;

  delete from qb_doc_lines l using jsonb_array_elements(p_docs) d
   where l.qb_type = d->>'qb_type' and l.qb_id = d->>'qb_id';
  insert into qb_doc_lines (qb_type, qb_id, line_no, item_id, item_name, description, qty, unit_price, amount, serials)
  select d->>'qb_type', d->>'qb_id', (l->>'line_no')::int, l->>'item_id', l->>'item_name', l->>'description',
         (l->>'qty')::numeric, (l->>'unit_price')::numeric, (l->>'amount')::numeric,
         coalesce(array(select jsonb_array_elements_text(l->'serials')), '{}')
  from jsonb_array_elements(p_docs) d, jsonb_array_elements(coalesce(d->'lines','[]')) l
  on conflict do nothing;
  return n;
end $$;

create table if not exists public.unit_spec_lines (
  id bigserial primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  qb_type text not null,
  qb_id text not null,
  line_no integer not null,
  item_name text,
  description text,
  qty numeric,
  amount numeric,
  own_serial text,
  moved_to_order_id uuid references public.orders(id) on delete set null,
  moved_to_loose boolean not null default false,
  moved_note text,
  moved_at timestamptz,
  moved_by text,
  refreshed_at timestamptz not null default now(),
  unique (qb_type, qb_id, line_no)
);
comment on table public.unit_spec_lines is 'Each unit''s build list, filled automatically from the vendor bill (or PO if no bill yet). A line can be moved to another unit or to loose inventory; the move survives the hourly refresh.';
create index if not exists unit_spec_lines_order_idx on public.unit_spec_lines(order_id);
create index if not exists unit_spec_lines_moved_idx on public.unit_spec_lines(moved_to_order_id);
alter table public.unit_spec_lines enable row level security;
drop policy if exists unit_spec_lines_read on public.unit_spec_lines;
create policy unit_spec_lines_read on public.unit_spec_lines for select to authenticated using (true);
drop policy if exists unit_spec_lines_move on public.unit_spec_lines;
create policy unit_spec_lines_move on public.unit_spec_lines for update to authenticated using (true) with check (true);

create or replace function public.unit_specs_refresh()
returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare n int;
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then raise exception 'robot only'; end if;

  create temp table _src on commit drop as
  select o.id as order_id, upper(trim(o.serial_number)) as unit_serial,
         case when o.qb_bill_id is not null and exists (select 1 from qb_docs where qb_type='Bill' and qb_id=o.qb_bill_id) then 'Bill'
              when o.qb_po_id is not null and exists (select 1 from qb_docs where qb_type='PurchaseOrder' and qb_id=o.qb_po_id) then 'PurchaseOrder' end as src_type,
         case when o.qb_bill_id is not null and exists (select 1 from qb_docs where qb_type='Bill' and qb_id=o.qb_bill_id) then o.qb_bill_id
              else o.qb_po_id end as src_id
  from orders o;
  delete from _src where src_type is null;

  delete from unit_spec_lines u using _src s
   where u.order_id = s.order_id and (u.qb_type, u.qb_id) <> (s.src_type, s.src_id) and u.moved_at is null;

  insert into unit_spec_lines as u (order_id, qb_type, qb_id, line_no, item_name, description, qty, amount, own_serial, refreshed_at)
  select s.order_id, l.qb_type, l.qb_id, l.line_no, l.item_name, nullif(trim(l.description),''), l.qty, l.amount,
         (select x from unnest(l.serials) x where x is distinct from s.unit_serial limit 1), now()
  from _src s join qb_doc_lines l on l.qb_type = s.src_type and l.qb_id = s.src_id
  where l.item_id is not null
  on conflict (qb_type, qb_id, line_no) do update set
    item_name = excluded.item_name, description = excluded.description, qty = excluded.qty,
    amount = excluded.amount, own_serial = excluded.own_serial, refreshed_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

alter table public.orders
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by text,
  add column if not exists archive_reason text,
  add column if not exists origin text;
update public.orders set origin = 'notion' where notion_id is not null and origin is null;

create or replace function public.qb_create_vendor_units()
returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare n int;
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then raise exception 'robot only'; end if;
  insert into orders (contract_number, contract_name, build_shorthand, qb_po_id, qb_po_doc_number, manufacturer_id,
                      ordered_date, our_cost, status, equipment_status, source_type, origin, mirror_review_note, notes)
  select q.doc_number,
         m.short_name || ' PO ' || q.doc_number || coalesce(' - ' || (select item_name from qb_doc_lines l where l.qb_type=q.qb_type and l.qb_id=q.qb_id and l.item_id is not null order by line_no limit 1), ''),
         m.short_name || ' PO ' || q.doc_number,
         q.qb_id, q.doc_number, m.id, q.txn_date, q.total,
         'order_pending', 'ordered', 'direct_order', 'qb_po',
         'Created from QuickBooks PO. Set the status, location and customer.',
         'Added from QuickBooks PO ' || q.doc_number || ' on ' || to_char(now() at time zone 'America/Denver', 'Mon DD, YYYY')
  from qb_docs q join manufacturers m on m.qb_vendor_id = q.party_id
  where q.qb_type = 'PurchaseOrder' and m.short_name in ('Daniels','Rawhide')
    and q.txn_date >= current_date - 365
    and not exists (select 1 from orders o where o.qb_po_id = q.qb_id or o.qb_po_doc_number = q.doc_number
                                              or coalesce(o.contract_number, o.moly_contract_number) = q.doc_number);
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.unit_specs_refresh() from public, anon, authenticated;
revoke all on function public.qb_create_vendor_units() from public, anon, authenticated;

-- Wire both into the hourly QuickBooks comparison, and keep the Notion review flag off
-- QuickBooks-made and archived units. Each edit is skipped if it is already in place.
do $$
declare d text;
begin
  d := pg_get_functiondef('public.qb_compare_run(timestamptz)'::regprocedure);
  if position('qb_create_vendor_units' in d) = 0 then
    d := replace(d, $x$  delete from qb_docs where fetched_at < p_fetch_started;$x$,
                    $x$  delete from qb_docs where fetched_at < p_fetch_started;
  perform qb_create_vendor_units();$x$);
    d := replace(d, $x$  delete from qb_mismatches where true;$x$,
                    $x$  perform unit_specs_refresh();
  delete from qb_mismatches where true;$x$);
    execute d;
  end if;

  d := pg_get_functiondef('public.notion_mirror_finish(timestamptz, boolean)'::regprocedure);
  if position('archived_at' in d) = 0 then
    d := replace(d, $x$     and o.status <> 'closed'$x$,
                    $x$     and o.status <> 'closed'
     and o.archived_at is null
     and coalesce(o.origin, 'notion') <> 'qb_po'$x$);
    execute d;
  end if;
end $$;

select 'Done. Tell Claude: ran it.' as result;
