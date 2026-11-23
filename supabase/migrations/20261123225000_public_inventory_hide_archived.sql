-- TITLE: Website Inventory Hides Archived Units ("No longer here" in the Hub)
create or replace function public.public_inventory()
 returns table(order_id uuid, title text, price numeric, description text, photo_url text, condition text, status text, sort_order integer)
 language sql stable security definer set search_path to 'public'
as $function$
  select l.order_id,
         coalesce(nullif(trim(l.title), ''), bm.name, o.contract_name, 'Equipment'),
         l.price, l.description, l.photo_url, l.condition,
         case when o.equipment_status in ('at_catl','ready') then 'On The Yard' else 'On Order' end,
         l.sort_order
  from public.website_listings l
  join public.orders o on o.id = l.order_id
  left join public.base_models bm on bm.id = o.base_model_id
  where l.show and o.customer_id is null and o.equipment_status is distinct from 'delivered'
    and o.archived_at is null
  order by l.sort_order nulls last, l.updated_at desc;
$function$;
