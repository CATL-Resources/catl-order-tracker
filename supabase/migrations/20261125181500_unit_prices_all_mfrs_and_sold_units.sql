-- TITLE: Unit Prices - Daniels And Rawhide Price List, Sold Units From QuickBooks Estimates
-- Chandy 2026-11-25: load Daniels/Rawhide prices; fill sold units with no retail.
-- Daniels/Rawhide retail = latest QuickBooks sale price (their cost runs 90% of it; panels/pins 85%).
-- Sold units take the price from their linked QuickBooks estimate (equipment only, freight left out).
-- Unsold units of every manufacturer get today's list price from their spec lines
-- (unmatched lines estimated as cost / 0.8 for Moly, cost / 0.9 for everyone else).
-- Re-runs automatically when spec lines, the price list, or a unit's customer/estimate/manufacturer change.
--
-- ROLLBACK (data rows this added):
--   delete from model_options where short_code in ('DAN-P12','DAN-SPA25','DAN-AG4','DAN-CN','DAN-CP5','DAN-RG','DAN-TL','DAN-HG','DAN-HPL','DAN-WPL','DAN-SDAR','RAW-HG','RAW-LC','RAW-TIRE','RAW-SLGN');
--   update orders set customer_id=null, qb_estimate_id=null, qb_estimate_doc_number=null where contract_number in ('2026 - Lake','2026 - M. Grussing','2026 - T & T Grussing','2026 Tamplin','9-18-26 Rohrbach');
--   update orders set qb_estimate_id=null, qb_estimate_doc_number=null where contract_number in ('45983','45987','45995','46535','46539');
--   delete from customers where qb_customer_id in ('3585','100000051','100000071','100000111','100000541');
--   update orders set manufacturer_id=null where contract_number in ('44159','45010');

insert into model_options (manufacturer_id, name, short_code, option_group, selection_type, cost_price, retail_price, is_active, qb_item_name, notes)
select m.id, v.name, v.code, 'accessory', 'simple', v.cost, v.retail, true, v.qb, v.note
from (values
 ('15e8fe09-0653-4282-ad34-1c9c24eb0f59'::uuid,'12'' Panel','DAN-P12',249.90,294.00,'Livestock Equipment:Daniels:12'' Panel','Retail = last QB sale 2026-10-20'),
 ('15e8fe09-0653-4282-ad34-1c9c24eb0f59','25''7" Single Portable Alley','DAN-SPA25',21555.00,26500.00,'Livestock Equipment:Daniels:25''7" Single Portable Alley','Retail = last QB sale 2026-10-20'),
 ('15e8fe09-0653-4282-ad34-1c9c24eb0f59','4'' Arch Gate','DAN-AG4',358.70,422.00,'Livestock Equipment:Daniels:4'' Arch gate','Retail = last QB sale 2026-03-20'),
 ('15e8fe09-0653-4282-ad34-1c9c24eb0f59','Calf Narrowers','DAN-CN',1800.00,2000.00,'Livestock Equipment:Daniels:Calf Narrowers','Retail = last QB sale 2026-11-18'),
 ('15e8fe09-0653-4282-ad34-1c9c24eb0f59','CP-5 Pins','DAN-CP5',9.78,11.50,'Livestock Equipment:Daniels:CP-5 Pins','Retail = last QB sale 2026-10-20'),
 ('15e8fe09-0653-4282-ad34-1c9c24eb0f59','Rear Gate','DAN-RG',373.50,415.00,'Livestock Equipment:Daniels:Daniels Rear gate','Retail = last QB sale 2026-11-18'),
 ('15e8fe09-0653-4282-ad34-1c9c24eb0f59','Travel Lights','DAN-TL',225.00,250.00,'Livestock Equipment:Daniels:Daniels Travel Lights','Retail = last QB sale 2025-09-10'),
 ('15e8fe09-0653-4282-ad34-1c9c24eb0f59','Headgate for Daniels','DAN-HG',1440.00,1600.00,'Livestock Equipment:Daniels:Headgate for Daniels','ESTIMATED: never sold; cost / 0.9. Confirm with Tim'),
 ('15e8fe09-0653-4282-ad34-1c9c24eb0f59','Horizontal Panel Loops','DAN-HPL',3.53,4.15,'Livestock Equipment:Daniels:Horizontal Panel Loops','ESTIMATED: last sale $2.75 was below cost; cost / 0.85. Confirm with Tim'),
 ('15e8fe09-0653-4282-ad34-1c9c24eb0f59','Weld On Panel Loops','DAN-WPL',1.49,1.75,'Livestock Equipment:Daniels:Weld On Panel Loops','ESTIMATED: last sale $1.15 was below cost; cost / 0.85. Confirm with Tim'),
 ('15e8fe09-0653-4282-ad34-1c9c24eb0f59','Stationary Double Alleyway - Rear','DAN-SDAR',9000.00,10000.00,'Livestock Equipment:Daniels:Stationary Double Alleyway-Rear','Retail = last QB sale 2026-09-01'),
 ('6bd9b7c0-c4e7-4d8b-be06-e1f2271fe12a','Headgate for Processor','RAW-HG',2295.00,2550.00,'Livestock Equipment:Rawhide Processor:Headgate for Processor','Retail = last QB sale 2026-11-02'),
 ('6bd9b7c0-c4e7-4d8b-be06-e1f2271fe12a','Loading Chute Option','RAW-LC',4500.00,5000.00,'Livestock Equipment:Rawhide Processor:Loading chute option','Retail = last QB sale 2026-02-10'),
 ('6bd9b7c0-c4e7-4d8b-be06-e1f2271fe12a','Spare Tire and Rim','RAW-TIRE',360.00,400.00,'Spare Tire and Rim-Rawhide Corral','Retail = last QB sale 2026-02-10'),
 ('6bd9b7c0-c4e7-4d8b-be06-e1f2271fe12a','Super Large RAWHIDE Classic Gooseneck','RAW-SLGN',33966.00,36960.00,'Super Large RAWHIDE Classic Gooseneck','Retail = QB estimate 2026-11-07')
) v(mid, name, code, cost, retail, qb, note)
join manufacturers m on m.id = v.mid
where not exists (select 1 from model_options x where lower(x.qb_item_name) = lower(v.qb))
  and not exists (select 1 from base_models x where lower(x.qb_item_name) = lower(v.qb));

update orders set manufacturer_id = 'b5cf513b-c38b-443e-bd13-8b2e79e1ccb6'
 where manufacturer_id is null and archived_at is null and contract_number in ('44159','45010');

insert into customers (name, qb_customer_id)
select v.n, v.q from (values ('Austin Lake','3585'),('Tyler and Taylor Grussing','100000051'),('Mark Grussing','100000071'),
                             ('Todd Tamplin','100000111'),('Joe Rohrbach','100000541')) v(n,q)
where not exists (select 1 from customers c where c.qb_customer_id = v.q);

update orders o set
  customer_id = coalesce(o.customer_id, c.id),
  qb_estimate_id = coalesce(o.qb_estimate_id, d.qb_id),
  qb_estimate_doc_number = coalesce(o.qb_estimate_doc_number, d.doc_number)
from (values ('45983','2026EST-273'),('45987','2026EST-236'),('45995','2026EST-280'),('46535','2026EST-274'),('46539','2026EST-287'),
             ('2026 - Lake','2026EST-154'),('2026 - M. Grussing','2026EST-180'),('2026 - T & T Grussing','2026EST-177'),
             ('2026 Tamplin','2026EST-188'),('9-18-26 Rohrbach','2026EST-262')) v(contract, est)
join qb_docs d on d.qb_type = 'Estimate' and d.doc_number = v.est
join customers c on c.qb_customer_id = d.party_id
where o.contract_number = v.contract and o.archived_at is null;

create or replace function public.unit_prices_refresh()
returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare n1 int; n2 int; n3 int; n4 int;
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

  with e as (
    select o.id, d.doc_number, round(sum(l.amount) filter (where l.item_name !~* '(freight|shipping)'), 2) equip
    from orders o
    join qb_docs d on d.qb_type = 'Estimate' and d.qb_id = o.qb_estimate_id
    join qb_doc_lines l on l.qb_type = d.qb_type and l.qb_id = d.qb_id
    where o.archived_at is null and o.customer_id is not null
    group by o.id, d.doc_number)
  update orders o set customer_price = e.equip, customer_price_source = 'qb_estimate',
    customer_price_note = 'From QuickBooks estimate ' || e.doc_number || ' (equipment only, freight not included).'
  from e
  where e.id = o.id and e.equip > 0
    and (coalesce(o.customer_price,0) = 0 or o.customer_price_source in ('qb_estimate','catalog_from_specs','catalog_at_sale'))
    and (o.customer_price is distinct from e.equip or o.customer_price_source is distinct from 'qb_estimate');
  get diagnostics n2 = row_count;

  drop table if exists _t;
  create temp table _t on commit drop as
  with cat as (
    select lower(trim(nm)) nm, min(rp) rp from (
      select qb_item_name nm, retail_price rp from base_models where qb_item_name is not null and is_active and coalesce(retail_price,0) > 0
      union all
      select qb_item_name, retail_price from model_options where qb_item_name is not null and is_active and coalesce(retail_price,0) > 0) c
    group by 1 having count(distinct rp) = 1),
  l as (
    select s.order_id, s.item_name, coalesce(nullif(s.qty,0),1) qty, s.amount, c.rp,
      case when o.manufacturer_id = 'b5cf513b-c38b-443e-bd13-8b2e79e1ccb6' then 0.8 else 0.9 end cost_share,
      case when s.item_name ~* '(^|:)\s*(freight|shipping)' then 'skip'
           when s.item_name ~* ':\s*material surcharge$' then 'passthru'
           when c.rp is not null then 'catalog' else 'estimated' end how
    from unit_spec_lines s
    join orders o on o.id = s.order_id
    left join cat c on c.nm = lower(trim(s.item_name))
    where not s.stale and s.moved_to_order_id is null and not coalesce(s.moved_to_loose,false))
  select order_id,
    round(sum(case how when 'catalog' then rp * qty when 'passthru' then amount when 'estimated' then amount / cost_share else 0 end), 2) retail,
    count(*) filter (where how = 'estimated') n_est,
    string_agg(regexp_replace(item_name, '^.*:', ''), ', ') filter (where how = 'estimated') est_items
  from l group by order_id;

  update orders o set
    customer_price = t.retail,
    customer_price_source = 'catalog_from_specs',
    customer_price_note = 'Today''s list price from the spec lines.' ||
      case when t.n_est > 0 then ' ' || t.n_est || ' line(s) not in the price list, estimated from cost: ' || t.est_items else '' end
  from _t t
  where t.order_id = o.id and o.archived_at is null and o.customer_id is null
    and (coalesce(o.customer_price,0) = 0 or o.customer_price_source = 'catalog_from_specs')
    and t.retail > 0
    and (o.customer_price is distinct from t.retail or o.customer_price_source is distinct from 'catalog_from_specs');
  get diagnostics n3 = row_count;

  update orders o set
    customer_price = t.retail,
    customer_price_source = 'catalog_at_sale',
    customer_price_note = 'No QuickBooks estimate linked; list price from the spec lines on ' || current_date || '.'
  from _t t
  where t.order_id = o.id and o.archived_at is null and o.customer_id is not null
    and coalesce(o.customer_price,0) = 0 and o.qb_estimate_id is null and t.retail > 0;
  get diagnostics n4 = row_count;

  return n1 + n2 + n3 + n4;
end $$;

revoke all on function public.unit_prices_refresh() from public, anon, authenticated;

create or replace function public.trg_orders_reprice()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$ begin
  if pg_trigger_depth() = 1 then perform public.unit_prices_refresh(); end if;
  return null;
end $$;

create or replace trigger orders_reprice_on_link
after update of customer_id, qb_estimate_id, manufacturer_id on public.orders
for each statement execute function public.trg_orders_reprice();

select public.unit_prices_refresh();
