-- TITLE: Daniels/Rawhide Unit Names Use The Short Item Name (drop QuickBooks category path)
do $$
declare d text;
begin
  d := pg_get_functiondef('public.qb_create_vendor_units()'::regprocedure);
  if position('regexp_replace(item_name' in d) = 0 then
    d := replace(d, $x$(select item_name from qb_doc_lines l$x$, $x$(select regexp_replace(item_name, '^.*:', '') from qb_doc_lines l$x$);
    execute d;
  end if;
end $$;

-- One-time tidy of the 17 units created 2026-11-23; only touches names that still carry the path.
update public.orders
   set contract_name = regexp_replace(contract_name, ' - [^-]*:([^:]+)$', ' - \1')
 where origin = 'qb_po' and contract_name ~ ' - [^-]*:[^:]+$';
