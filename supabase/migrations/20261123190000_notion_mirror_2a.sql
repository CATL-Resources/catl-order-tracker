-- TITLE: Notion Equipment Board Mirror (step 2A)
-- One-way copy: Notion "Equipment" board -> Hub. Notion stays the master. Nothing here writes to Notion.

create table if not exists public.notion_equipment (
  notion_id text primary key,
  notion_url text,
  created_at_notion timestamptz,
  last_edited_notion timestamptz,
  contract_name text,
  contract_number text,
  catl_number text,
  serial_number text,
  customer text,
  customer_location text,
  phone text,
  email text,
  manufacturer text,
  equipment_type text,
  description text,
  power_unit text[] not null default '{}',
  customer_mods text[] not null default '{}',
  equipment_status text[] not null default '{}',
  transaction_status text[] not null default '{}',
  equip_location text[] not null default '{}',
  est_completion date,
  order_date date,
  moly_dp boolean not null default false,
  contract_signed boolean not null default false,
  truck text,
  delivery_instructions text,
  is_active boolean generated always as (
    not (equipment_status && array['SOLD','Equip Completed']::text[])
    and not ('Transaction Complete' = any(transaction_status))
  ) stored,
  order_id uuid references public.orders(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  removed_from_notion boolean not null default false
);
comment on table public.notion_equipment is 'Copy of every row on Tim''s Notion Equipment board. Filled by the notion-mirror robot every 15 minutes. Notion is the master; do not edit here.';
create index if not exists notion_equipment_order_idx on public.notion_equipment(order_id);
create index if not exists notion_equipment_contract_idx on public.notion_equipment(contract_number);
alter table public.notion_equipment enable row level security;
create policy notion_equipment_read on public.notion_equipment for select to authenticated using (true);

create table if not exists public.notion_mirror_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  source text,
  rows_seen integer,
  orders_updated integer,
  orders_created integer,
  error text
);
alter table public.notion_mirror_runs enable row level security;
create policy notion_mirror_runs_read on public.notion_mirror_runs for select to authenticated using (true);

alter table public.orders
  add column if not exists notion_active boolean,
  add column if not exists notion_synced_at timestamptz,
  add column if not exists mirror_review_note text;

create unique index if not exists orders_notion_id_key on public.orders(notion_id) where notion_id is not null;

-- Apply a batch of Notion rows. Each element of p_rows is one Notion page, already flattened.
-- Match order: already linked (notion_id), then contract number, then serial number.
-- Only active rows that carry a contract or serial number (and are not group headings) become new Hub orders.
create or replace function public.notion_mirror_apply(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r jsonb;
  v_id text;
  v_contract text;
  v_serial text;
  v_order uuid;
  v_mfr uuid;
  v_cust uuid;
  v_active boolean;
  v_loc text;
  n_seen int := 0; n_upd int := 0; n_new int := 0;
  arr text[];
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then
    raise exception 'notion_mirror_apply is for the mirror robot only';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    n_seen := n_seen + 1;
    v_id := lower(replace(r->>'notion_id','-',''));
    v_contract := nullif(regexp_replace(coalesce(r->>'contract_number',''), '\.0+$', ''), '');
    v_serial := nullif(upper(trim(coalesce(r->>'serial_number',''))), '');

    insert into notion_equipment as n (
      notion_id, notion_url, created_at_notion, last_edited_notion, contract_name, contract_number, catl_number,
      serial_number, customer, customer_location, phone, email, manufacturer, equipment_type, description,
      power_unit, customer_mods, equipment_status, transaction_status, equip_location,
      est_completion, order_date, moly_dp, contract_signed, truck, delivery_instructions,
      last_seen_at, removed_from_notion)
    values (
      v_id, r->>'url', (r->>'created_at')::timestamptz, (r->>'last_edited')::timestamptz,
      nullif(trim(r->>'contract_name'),''), v_contract,
      nullif(regexp_replace(coalesce(r->>'catl_number',''), '\.0+$', ''), ''),
      v_serial, nullif(trim(r->>'customer'),''), nullif(trim(r->>'customer_location'),''),
      nullif(trim(r->>'phone'),''), nullif(trim(coalesce(r->>'email', r->>'email_1')),''),
      nullif(r->>'manufacturer',''), nullif(r->>'type',''), nullif(trim(r->>'description'),''),
      coalesce(array(select jsonb_array_elements_text(coalesce(r->'power_unit','[]'))), '{}'),
      coalesce(array(select jsonb_array_elements_text(coalesce(r->'customer_mods','[]'))), '{}'),
      coalesce(array(select jsonb_array_elements_text(coalesce(r->'equipment_status','[]'))), '{}'),
      coalesce(array(select jsonb_array_elements_text(coalesce(r->'transaction_status','[]'))), '{}'),
      coalesce(array(select jsonb_array_elements_text(coalesce(r->'equip_location','[]'))), '{}'),
      left(r->>'est_completion',10)::date, left(r->>'order_date',10)::date,
      coalesce((r->>'moly_dp')::boolean,false), coalesce((r->>'contract_signed')::boolean,false),
      nullif(trim(r->>'truck'),''), nullif(trim(r->>'delivery_instructions'),''),
      now(), false)
    on conflict (notion_id) do update set
      notion_url = excluded.notion_url, created_at_notion = excluded.created_at_notion,
      last_edited_notion = excluded.last_edited_notion, contract_name = excluded.contract_name,
      contract_number = excluded.contract_number, catl_number = excluded.catl_number,
      serial_number = excluded.serial_number, customer = excluded.customer,
      customer_location = excluded.customer_location, phone = excluded.phone, email = excluded.email,
      manufacturer = excluded.manufacturer, equipment_type = excluded.equipment_type,
      description = excluded.description, power_unit = excluded.power_unit,
      customer_mods = excluded.customer_mods, equipment_status = excluded.equipment_status,
      transaction_status = excluded.transaction_status, equip_location = excluded.equip_location,
      est_completion = excluded.est_completion, order_date = excluded.order_date,
      moly_dp = excluded.moly_dp, contract_signed = excluded.contract_signed, truck = excluded.truck,
      delivery_instructions = excluded.delivery_instructions, last_seen_at = now(), removed_from_notion = false;

    select is_active, equip_location into v_active, arr from notion_equipment where notion_id = v_id;
    v_loc := nullif(array_to_string(arr, ', '), '');

    select id into v_order from orders where notion_id = v_id;
    if v_order is null and v_contract is not null then
      select id into v_order from orders
       where notion_id is null and (contract_number = v_contract or moly_contract_number = v_contract)
       order by updated_at desc nulls last limit 1;
    end if;
    if v_order is null and v_serial is not null then
      select id into v_order from orders
       where notion_id is null and upper(trim(serial_number)) = v_serial
       order by updated_at desc nulls last limit 1;
    end if;

    select id into v_mfr from manufacturers m
     where r->>'manufacturer' is not null
       and (m.name ilike r->>'manufacturer' or m.short_name ilike r->>'manufacturer'
            or m.name ilike split_part(r->>'manufacturer',' ',1) || '%')
     limit 1;

    if v_order is not null then
      update orders o set
        notion_id = v_id,
        contract_name = coalesce(nullif(trim(r->>'contract_name'),''), o.contract_name),
        contract_number = coalesce(o.contract_number, v_contract),
        catl_number = coalesce(nullif(regexp_replace(coalesce(r->>'catl_number',''), '\.0+$', ''), ''), o.catl_number),
        serial_number = coalesce(v_serial, o.serial_number),
        customer_location = coalesce(nullif(trim(r->>'customer_location'),''), o.customer_location),
        delivery_instructions = coalesce(nullif(trim(r->>'delivery_instructions'),''), o.delivery_instructions),
        est_completion_date = coalesce(left(r->>'est_completion',10)::date, o.est_completion_date),
        ordered_date = coalesce(left(r->>'order_date',10)::date, o.ordered_date),
        equip_location = coalesce(v_loc, o.equip_location),
        manufacturer_id = coalesce(o.manufacturer_id, v_mfr),
        notion_active = v_active,
        notion_synced_at = now(),
        mirror_review_note = case when v_active then null else o.mirror_review_note end
      where o.id = v_order;
      n_upd := n_upd + 1;
    elsif v_active and (v_contract is not null or v_serial is not null)
          and coalesce(r->>'contract_name','') !~* '(thru|contracts)' then
      v_cust := null;
      if coalesce(r->>'customer','') !~* '^\s*(available|stock|)\s*$' then
        select id into v_cust from customers c
         where lower(trim(c.name)) = lower(trim(r->>'customer')) or lower(trim(c.company)) = lower(trim(r->>'customer'))
         limit 1;
      end if;
      insert into orders (notion_id, contract_name, contract_number, catl_number, serial_number,
        customer_location, delivery_instructions, est_completion_date, ordered_date, equip_location,
        manufacturer_id, customer_id, build_shorthand, status, equipment_status, source_type,
        notion_active, notion_synced_at, notes)
      values (v_id, nullif(trim(r->>'contract_name'),''), v_contract,
        nullif(regexp_replace(coalesce(r->>'catl_number',''), '\.0+$', ''), ''), v_serial,
        nullif(trim(r->>'customer_location'),''), nullif(trim(r->>'delivery_instructions'),''),
        left(r->>'est_completion',10)::date, left(r->>'order_date',10)::date, v_loc,
        v_mfr, v_cust, coalesce(nullif(trim(r->>'contract_name'),''), 'Notion unit'),
        'order_pending', 'ordered', 'direct_order', true, now(),
        'Added by the Notion mirror on ' || to_char(now() at time zone 'America/Denver', 'Mon DD, YYYY'))
      returning id into v_order;
      n_new := n_new + 1;
    end if;

    update notion_equipment set order_id = v_order where notion_id = v_id and v_order is not null;
  end loop;

  return jsonb_build_object('rows_seen', n_seen, 'orders_updated', n_upd, 'orders_created', n_new);
end;
$$;

-- After a full pass: mark rows gone from Notion, and flag Hub orders that are not an active Notion unit.
create or replace function public.notion_mirror_finish(p_run_started timestamptz, p_full_run boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare n_removed int := 0; n_flagged int := 0;
begin
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then
    raise exception 'notion_mirror_finish is for the mirror robot only';
  end if;
  if p_full_run then
    update notion_equipment set removed_from_notion = true
     where last_seen_at < p_run_started and not removed_from_notion;
    get diagnostics n_removed = row_count;
    update orders o set notion_active = false
      from notion_equipment n where n.order_id = o.id and n.removed_from_notion;
  end if;

  update orders o set mirror_review_note =
      case when o.notion_id is null then 'Not on the Notion board. Review: link it to a Notion row or close it.'
           else 'On the Notion board but marked sold or complete there. Review: close it in the Hub.' end
   where coalesce(o.notion_active, false) = false
     and o.status <> 'closed'
     and o.mirror_review_note is null;
  get diagnostics n_flagged = row_count;

  return jsonb_build_object('removed_from_notion', n_removed, 'newly_flagged', n_flagged);
end;
$$;

revoke all on function public.notion_mirror_apply(jsonb) from public, anon, authenticated;
revoke all on function public.notion_mirror_finish(timestamptz, boolean) from public, anon, authenticated;
