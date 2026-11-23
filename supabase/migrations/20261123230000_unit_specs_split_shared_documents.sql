-- TITLE: Unit Specs - Split A Shared Bill Or PO Between Its Units
-- One Moly bill or PO can cover several units. Each line belongs to the unit whose serial or contract number
-- appears on that line or the nearest line above it. Lines above any marker go to the unit whose contract
-- number is the document number, else the oldest order. Old lines are marked stale (hidden), not removed.

alter table public.unit_spec_lines add column if not exists stale boolean not null default false;

create or replace function public.unit_specs_refresh()
returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare n int;
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then raise exception 'robot only'; end if;

  create temp table _src on commit drop as
  select o.id as order_id, o.created_at,
         nullif(upper(trim(o.serial_number)), '') as unit_serial,
         coalesce(o.contract_number, o.moly_contract_number) as unit_contract,
         case when o.qb_bill_id is not null and exists (select 1 from qb_docs where qb_type='Bill' and qb_id=o.qb_bill_id) then 'Bill'
              when o.qb_po_id is not null and exists (select 1 from qb_docs where qb_type='PurchaseOrder' and qb_id=o.qb_po_id) then 'PurchaseOrder' end as src_type,
         case when o.qb_bill_id is not null and exists (select 1 from qb_docs where qb_type='Bill' and qb_id=o.qb_bill_id) then o.qb_bill_id
              else o.qb_po_id end as src_id
  from orders o
  where o.archived_at is null;

  create temp table _assign on commit drop as
  with lines as (
    select l.*,
      (select s.order_id from _src s
        where s.src_type = l.qb_type and s.src_id = l.qb_id
          and ((s.unit_serial is not null and upper(coalesce(l.description,'')) like '%' || s.unit_serial || '%')
            or (s.unit_contract is not null and coalesce(l.description,'') ~ ('\m' || s.unit_contract || '\M')))
        order by s.created_at limit 1) as marker
    from qb_doc_lines l
    where l.item_id is not null
      and exists (select 1 from _src s where s.src_type = l.qb_type and s.src_id = l.qb_id)
  ), filled as (
    select lines.*,
      (array_remove(array_agg(marker) over (partition by qb_type, qb_id order by line_no), null)) as markers
    from lines
  )
  select f.qb_type, f.qb_id, f.line_no, f.item_name, f.description, f.qty, f.amount, f.serials,
    coalesce(f.markers[array_upper(f.markers, 1)],
      (select s.order_id from _src s join qb_docs d on d.qb_type = s.src_type and d.qb_id = s.src_id
        where s.src_type = f.qb_type and s.src_id = f.qb_id
        order by (s.unit_contract = d.doc_number) desc nulls last, s.created_at limit 1)) as order_id
  from filled f;

  update unit_spec_lines u set stale = true
   where u.moved_at is null and not u.stale
     and not exists (select 1 from _assign a where a.qb_type = u.qb_type and a.qb_id = u.qb_id and a.line_no = u.line_no);

  insert into unit_spec_lines as u (order_id, qb_type, qb_id, line_no, item_name, description, qty, amount, own_serial, stale, refreshed_at)
  select a.order_id, a.qb_type, a.qb_id, a.line_no, a.item_name, nullif(trim(a.description),''), a.qty, a.amount,
         (select x from unnest(a.serials) x where x is distinct from (select unit_serial from _src s where s.order_id = a.order_id limit 1) limit 1),
         false, now()
  from _assign a
  where a.order_id is not null
  on conflict (qb_type, qb_id, line_no) do update set
    order_id = excluded.order_id, item_name = excluded.item_name, description = excluded.description,
    qty = excluded.qty, amount = excluded.amount, own_serial = excluded.own_serial, stale = false, refreshed_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.unit_specs_refresh() from public, anon, authenticated;
