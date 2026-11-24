-- TITLE: Unit Prices - Fill Retail And Cost From Spec Lines Automatically
-- Ruling (Chandy, 2026-11-24): every unsold chute carries TODAY's list price, regardless of what it cost.
-- our_cost = sum of the unit's live spec lines (what we paid). customer_price (unsold Moly units) =
-- today's catalog retail x qty; unmatched lines estimated as cost / 0.8; Freight left out; Material surcharge at cost.
-- Only fills blanks or prices this function set itself. Never touches typed-in prices or sold units.

alter table public.orders add column if not exists customer_price_source text;
alter table public.orders add column if not exists customer_price_note text;
alter table public.orders add column if not exists our_cost_source text;

create or replace function public.unit_prices_refresh()
returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare n1 int; n2 int;
begin
  with s as (
    select order_id, sum(amount) amt from unit_spec_lines
    where not stale and moved_to_order_id is null and not coalesce(moved_to_loose,false)
    group by order_id)
  update orders o set our_cost = round(s.amt, 2), our_cost_source = 'spec_lines'
  from s
  where s.order_id = o.id and o.archived_at is null
    and (coalesce(o.our_cost,0) = 0 or o.our_cost_source = 'spec_lines')
    and o.our_cost is distinct from round(s.amt, 2);
  get diagnostics n1 = row_count;

  with cat as (
    select lower(trim(nm)) nm, min(rp) rp from (
      select qb_item_name nm, retail_price rp from base_models where qb_item_name is not null and is_active and coalesce(retail_price,0) > 0
      union all
      select qb_item_name, retail_price from model_options where qb_item_name is not null and is_active and coalesce(retail_price,0) > 0) c
    group by 1 having count(distinct rp) = 1),
  l as (
    select s.order_id, s.item_name, coalesce(nullif(s.qty,0),1) qty, s.amount, c.rp,
      case when s.item_name ~* ':\s*freight$' then 'skip'
           when s.item_name ~* ':\s*material surcharge$' then 'passthru'
           when c.rp is not null then 'catalog' else 'estimated' end how
    from unit_spec_lines s
    left join cat c on c.nm = lower(trim(s.item_name))
    where not s.stale and s.moved_to_order_id is null and not coalesce(s.moved_to_loose,false)),
  t as (
    select order_id,
      round(sum(case how when 'catalog' then rp * qty when 'passthru' then amount when 'estimated' then amount / 0.8 else 0 end), 2) retail,
      count(*) filter (where how = 'estimated') n_est,
      string_agg(regexp_replace(item_name, '^.*:', ''), ', ') filter (where how = 'estimated') est_items
    from l group by order_id)
  update orders o set
    customer_price = t.retail,
    customer_price_source = 'catalog_from_specs',
    customer_price_note = case when t.n_est > 0
      then 'Today''s list price from the spec lines. ' || t.n_est || ' line(s) not in the price list, estimated from cost: ' || t.est_items
      else 'Today''s list price from the spec lines.' end
  from t
  where t.order_id = o.id and o.archived_at is null and o.customer_id is null
    and o.manufacturer_id = 'b5cf513b-c38b-443e-bd13-8b2e79e1ccb6'
    and (coalesce(o.customer_price,0) = 0 or o.customer_price_source = 'catalog_from_specs')
    and t.retail > 0
    and (o.customer_price is distinct from t.retail or o.customer_price_note is distinct from
         case when t.n_est > 0 then 'Today''s list price from the spec lines. ' || t.n_est || ' line(s) not in the price list, estimated from cost: ' || t.est_items
              else 'Today''s list price from the spec lines.' end);
  get diagnostics n2 = row_count;
  return n1 + n2;
end $$;

revoke all on function public.unit_prices_refresh() from public, anon, authenticated;

create or replace function public.trg_unit_spec_lines_reprice()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$ begin perform public.unit_prices_refresh(); return null; end $$;

create or replace trigger unit_spec_lines_reprice
after insert or update or delete on public.unit_spec_lines
for each statement execute function public.trg_unit_spec_lines_reprice();

select public.unit_prices_refresh();
