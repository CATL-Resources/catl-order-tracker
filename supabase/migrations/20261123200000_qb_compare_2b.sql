-- TITLE: QuickBooks Comparison (step 2B) - read-only copy of QuickBooks documents, matched to orders
-- Nothing here writes to QuickBooks.

create table if not exists public.qb_docs (
  qb_type text not null,
  qb_id text not null,
  doc_number text,
  txn_date date,
  party_name text,
  total numeric,
  balance numeric,
  keys_contract text[] not null default '{}',
  keys_serial text[] not null default '{}',
  keys_catl text[] not null default '{}',
  fetched_at timestamptz not null default now(),
  primary key (qb_type, qb_id)
);
comment on table public.qb_docs is 'Read-only copy of QuickBooks estimates, POs, bills, invoices and sales receipts since 2024, with the contract, serial and CATL numbers found in them. Refilled hourly by qb-order-compare.';
create index if not exists qb_docs_contract_idx on public.qb_docs using gin (keys_contract);
create index if not exists qb_docs_serial_idx on public.qb_docs using gin (keys_serial);
create index if not exists qb_docs_catl_idx on public.qb_docs using gin (keys_catl);
alter table public.qb_docs enable row level security;
create policy qb_docs_read on public.qb_docs for select to authenticated using (true);

create table if not exists public.qb_compare_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  docs_fetched integer,
  orders_checked integer,
  mismatches integer,
  error text
);
alter table public.qb_compare_runs enable row level security;
create policy qb_compare_runs_read on public.qb_compare_runs for select to authenticated using (true);

create table if not exists public.qb_mismatches (
  id bigserial primary key,
  kind text not null,
  label text not null,
  detail text,
  order_id uuid references public.orders(id) on delete cascade,
  notion_id text,
  contract_number text,
  serial_number text,
  qb_type text,
  qb_id text,
  doc_number text,
  amount numeric,
  found_at timestamptz not null default now()
);
comment on table public.qb_mismatches is 'Where the Notion board and QuickBooks disagree. Rebuilt every hour; shown on the order board for Chandy and Tim.';
alter table public.qb_mismatches enable row level security;
create policy qb_mismatches_read on public.qb_mismatches for select to authenticated using (true);

alter table public.orders
  add column if not exists qb_invoiced boolean,
  add column if not exists qb_invoice_date date,
  add column if not exists qb_invoice_total numeric,
  add column if not exists qb_invoice_balance numeric,
  add column if not exists qb_paid boolean,
  add column if not exists qb_moly_billed boolean,
  add column if not exists qb_moly_bill_date date,
  add column if not exists qb_compared_at timestamptz;

create or replace function public.qb_docs_save(p_docs jsonb)
returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare n int;
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then raise exception 'robot only'; end if;
  insert into qb_docs as q (qb_type, qb_id, doc_number, txn_date, party_name, total, balance, keys_contract, keys_serial, keys_catl, fetched_at)
  select d->>'qb_type', d->>'qb_id', d->>'doc_number', (d->>'txn_date')::date, d->>'party_name',
         (d->>'total')::numeric, (d->>'balance')::numeric,
         coalesce(array(select jsonb_array_elements_text(d->'keys_contract')), '{}'),
         coalesce(array(select jsonb_array_elements_text(d->'keys_serial')), '{}'),
         coalesce(array(select jsonb_array_elements_text(d->'keys_catl')), '{}'),
         now()
  from jsonb_array_elements(p_docs) d
  on conflict (qb_type, qb_id) do update set
    doc_number = excluded.doc_number, txn_date = excluded.txn_date, party_name = excluded.party_name,
    total = excluded.total, balance = excluded.balance, keys_contract = excluded.keys_contract,
    keys_serial = excluded.keys_serial, keys_catl = excluded.keys_catl, fetched_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.qb_compare_run(p_fetch_started timestamptz)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare n_orders int; n_mis int;
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then raise exception 'robot only'; end if;

  delete from qb_docs where fetched_at < p_fetch_started;

  create temp table _m on commit drop as
  with o as (
    select id,
      coalesce(contract_number, moly_contract_number) as k_contract,
      upper(trim(serial_number)) as k_serial,
      nullif(regexp_replace(coalesce(catl_number,''), '\D', '', 'g'), '') as k_catl
    from orders
  )
  select o.id,
    (select q from qb_docs q where q.qb_type = 'PurchaseOrder' and o.k_contract is not null
       and (q.doc_number = o.k_contract or o.k_contract = any(q.keys_contract)) order by q.txn_date desc limit 1) as po,
    (select q from qb_docs q where q.qb_type = 'Bill' and o.k_contract is not null
       and (q.doc_number = o.k_contract or o.k_contract = any(q.keys_contract)) order by q.txn_date desc limit 1) as bill,
    (select q from qb_docs q where q.qb_type = 'Estimate'
       and ((o.k_serial is not null and o.k_serial = any(q.keys_serial)) or (o.k_catl is not null and o.k_catl = any(q.keys_catl))
            or (o.k_contract is not null and o.k_contract = any(q.keys_contract))) order by q.txn_date desc limit 1) as est,
    (select q from qb_docs q where q.qb_type in ('Invoice','SalesReceipt')
       and ((o.k_serial is not null and o.k_serial = any(q.keys_serial)) or (o.k_catl is not null and o.k_catl = any(q.keys_catl))
            or (o.k_contract is not null and o.k_contract = any(q.keys_contract))) order by q.txn_date desc limit 1) as inv
  from o;

  update orders x set
    qb_po_id = coalesce(x.qb_po_id, (m.po).qb_id),
    qb_po_doc_number = coalesce(x.qb_po_doc_number, (m.po).doc_number),
    qb_bill_id = coalesce(x.qb_bill_id, (m.bill).qb_id),
    qb_bill_doc_number = coalesce(x.qb_bill_doc_number, (m.bill).doc_number),
    qb_estimate_id = coalesce(x.qb_estimate_id, (m.est).qb_id),
    qb_estimate_doc_number = coalesce(x.qb_estimate_doc_number, (m.est).doc_number),
    qb_invoice_id = coalesce(x.qb_invoice_id, case when (m.inv).qb_type = 'Invoice' then (m.inv).qb_id end),
    qb_invoice_doc_number = coalesce(x.qb_invoice_doc_number, case when (m.inv).qb_type = 'Invoice' then (m.inv).doc_number end),
    qb_invoiced = (m.inv).qb_id is not null,
    qb_invoice_date = (m.inv).txn_date,
    qb_invoice_total = (m.inv).total,
    qb_invoice_balance = case when (m.inv).qb_type = 'SalesReceipt' then 0 else (m.inv).balance end,
    qb_paid = case when (m.inv).qb_id is null then null
                   when (m.inv).qb_type = 'SalesReceipt' then true
                   else coalesce((m.inv).balance, 0) = 0 end,
    qb_moly_billed = (m.bill).qb_id is not null,
    qb_moly_bill_date = (m.bill).txn_date,
    qb_compared_at = now()
  from _m m where m.id = x.id;
  get diagnostics n_orders = row_count;

  delete from qb_mismatches where true;

  insert into qb_mismatches (kind, label, detail, order_id, notion_id, contract_number, serial_number, qb_type, qb_id, doc_number, amount)
  select 'paid_but_open', 'Paid in QuickBooks, still open on the board',
         'Invoice ' || coalesce(o.qb_invoice_doc_number, '?') || ' dated ' || to_char(o.qb_invoice_date, 'Mon DD, YYYY') || ' is fully paid. The board should probably mark this unit Transaction Complete.',
         o.id, n.notion_id, n.contract_number, n.serial_number, 'Invoice', o.qb_invoice_id, o.qb_invoice_doc_number, o.qb_invoice_total
  from notion_equipment n join orders o on o.id = n.order_id
  where n.is_active and not n.removed_from_notion and o.qb_paid;

  insert into qb_mismatches (kind, label, detail, order_id, notion_id, contract_number, serial_number, qb_type, qb_id, doc_number, amount)
  select 'needs_invoiced_but_invoiced', 'Board says Needs Invoiced, but QuickBooks has the invoice',
         'Invoice ' || coalesce(o.qb_invoice_doc_number, '?') || ' dated ' || to_char(o.qb_invoice_date, 'Mon DD, YYYY')
           || case when o.qb_paid then ' (paid).' else ', balance owed $' || to_char(o.qb_invoice_balance, 'FM999,999,990.00') || '.' end,
         o.id, n.notion_id, n.contract_number, n.serial_number, 'Invoice', o.qb_invoice_id, o.qb_invoice_doc_number, o.qb_invoice_total
  from notion_equipment n join orders o on o.id = n.order_id
  where not n.removed_from_notion and 'Needs Invoiced' = any(n.transaction_status) and o.qb_invoiced;

  insert into qb_mismatches (kind, label, detail, order_id, notion_id, contract_number, serial_number)
  select 'delivered_not_invoiced', 'Delivered or picked up, but no QuickBooks invoice found',
         coalesce(n.contract_name, 'Unit') || ' for ' || coalesce(n.customer, 'unknown customer')
           || '. No invoice mentions serial ' || coalesce(n.serial_number, '(none on board)') || coalesce(', CATL ' || n.catl_number, '')
           || ' or contract ' || coalesce(n.contract_number, '(none)') || '. Check whether it was billed.',
         n.order_id, n.notion_id, n.contract_number, n.serial_number
  from notion_equipment n left join orders o on o.id = n.order_id
  where not n.removed_from_notion
    and not ('Transaction Complete' = any(n.transaction_status))
    and ('Delivered' = any(n.equip_location) or 'picked up by customer' = any(n.transaction_status))
    and coalesce(o.qb_invoiced, false) = false
    and coalesce(n.customer, '') !~* '^\s*(catl|available|in use)';

  insert into qb_mismatches (kind, label, detail, qb_type, qb_id, doc_number, amount)
  select 'qb_po_no_board_row', 'QuickBooks purchase order with no board row',
         'PO ' || q.doc_number || ' to ' || coalesce(q.party_name, 'a vendor') || ' dated ' || to_char(q.txn_date, 'Mon DD, YYYY') || ' is not on the Notion board or in the Hub.',
         q.qb_type, q.qb_id, q.doc_number, q.total
  from qb_docs q
  where q.qb_type = 'PurchaseOrder' and q.txn_date >= current_date - 365
    and not exists (select 1 from notion_equipment n where n.contract_number = q.doc_number or n.contract_number = any(q.keys_contract))
    and not exists (select 1 from orders o where coalesce(o.contract_number, o.moly_contract_number) = q.doc_number
                                             or o.qb_po_doc_number = q.doc_number);

  insert into qb_mismatches (kind, label, detail, qb_type, qb_id, doc_number, amount, serial_number)
  select 'qb_invoice_no_board_row', 'QuickBooks invoice for a unit not on the board',
         'Invoice ' || coalesce(q.doc_number, q.qb_id) || ' to ' || coalesce(q.party_name, 'a customer') || ' dated ' || to_char(q.txn_date, 'Mon DD, YYYY')
           || ' names serial ' || array_to_string(q.keys_serial, ', ') || ', which is not on the Notion board or in the Hub.',
         q.qb_type, q.qb_id, q.doc_number, q.total, q.keys_serial[1]
  from qb_docs q
  where q.qb_type in ('Invoice','SalesReceipt') and q.txn_date >= current_date - 365 and cardinality(q.keys_serial) > 0
    and not exists (select 1 from notion_equipment n where n.serial_number = any(q.keys_serial))
    and not exists (select 1 from orders o where upper(trim(o.serial_number)) = any(q.keys_serial));

  select count(*) into n_mis from qb_mismatches;
  return jsonb_build_object('orders_checked', n_orders, 'mismatches', n_mis);
end $$;

revoke all on function public.qb_docs_save(jsonb) from public, anon, authenticated;
revoke all on function public.qb_compare_run(timestamptz) from public, anon, authenticated;
