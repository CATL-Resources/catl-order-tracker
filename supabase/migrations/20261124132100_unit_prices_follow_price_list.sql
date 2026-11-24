-- TITLE: Unit Prices - Re-Price Unsold Chutes When The Price List Changes
create or replace trigger base_models_reprice_units
after insert or update or delete on public.base_models
for each statement execute function public.trg_unit_spec_lines_reprice();

create or replace trigger model_options_reprice_units
after insert or update or delete on public.model_options
for each statement execute function public.trg_unit_spec_lines_reprice();
