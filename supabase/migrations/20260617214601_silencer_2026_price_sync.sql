-- Silencer 2026 Combined Price List -> catalog sync (Moly Manufacturing)
-- Source: Silencer_Chute_Combined_Price_List_2026.xlsx (QuickBooks-reconciled)
-- Catalog only (Supabase model_options). No QuickBooks writes. base_models unchanged.
-- Scopes price-list options per model via model_restriction (full lockdown);
-- non-list CATL options (mods, extended-chute, scale components) left untouched.
BEGIN;

-- A. Fix 3 stale QB linkages (guarded; no-op if already applied)
UPDATE model_options SET qb_item_id='1324', qb_item_name='De-Horner Head Restraint' WHERE id='5c893e36-b8d7-4b68-aa1e-44ec55ed5c89' AND qb_item_id='312';
UPDATE model_options SET qb_item_id='1545', retail_price=6427.00, cost_price=5141.60, margin_percent=20.00, qb_item_name='Heavy Yoke Carrier - EXTENDED Length' WHERE id='a4eda896-92cb-4a8f-835e-5459ac84d6fc' AND qb_item_id='739';
UPDATE model_options SET qb_item_id='1546', retail_price=5422.00, cost_price=4337.60, margin_percent=20.00, qb_item_name='Gas Pump 12 HP Closed Center' WHERE id='9fb9e526-1e03-46fb-9722-059030d8a416' AND qb_item_id='912';

-- B. Per-model model_restriction (full lockdown to the 2026 list)
UPDATE model_options SET model_restriction='{R,RWB,HD,HDWB}' WHERE id='07838cd9-3fec-4ada-89f1-d9b007bb0692';  -- CA qb305
UPDATE model_options SET model_restriction='{R,RWB,HD,HDWB,CP,CPW}' WHERE id='71fefccb-6e21-43c7-bb41-9098ae8d3d63';  -- HY qb306
UPDATE model_options SET model_restriction='{R,RWB,HD,HDWB,CP,CPW}' WHERE id='a4eda896-92cb-4a8f-835e-5459ac84d6fc';  -- HY-EXT qb1545
UPDATE model_options SET model_restriction='{R,RWB,HD,HDWB,CP,CPW,MX}' WHERE id='1bd42d09-7cec-44e4-bb9b-b85d40b66371';  -- HYT qb913
UPDATE model_options SET model_restriction='{R,RWB,HD,HDWB,CP,CPW,MX}' WHERE id='cb49b617-09b8-4f54-b5b5-baa96f03a10c';  -- HYT-EXT qb913
UPDATE model_options SET model_restriction='{R,RWB}' WHERE id='460eb37a-ee69-4c90-b5df-9a84eff78eda';  -- YC qb307
UPDATE model_options SET model_restriction='{R,RWB,HD,HDWB,CP,CPW,MX}' WHERE id='781cc905-05f0-4537-b2e0-a550275d646e';  -- DC qb322
UPDATE model_options SET model_restriction='{R,RWB,HD,HDWB,CP,CPW,MX}' WHERE id='ae39c789-46d7-4faf-8263-851f76a5b38e';  -- PC qb324
UPDATE model_options SET model_restriction='{R,RWB,HD,HDWB,CP,CPW,MX}' WHERE id='18ed89a2-6938-4a28-b7b3-c8091578f82e';  -- PC-FB qb324
UPDATE model_options SET model_restriction='{R,RWB,HD,HDWB,CP,CPW,MX}' WHERE id='5d91ef89-2ae5-43cf-92ef-469e3cec78ea';  -- POS qb323
UPDATE model_options SET model_restriction='{R,RWB,HD,HDWB,CP,CPW,MX}' WHERE id='cb0f17f7-acba-4101-92b1-35dde25cd46f';  -- HSE qb940
UPDATE model_options SET model_restriction='{R,RWB,HD,HDWB,CP,CPW,MX}' WHERE id='a85c932f-db04-4cea-819f-3dc9f2999c76';  -- QSE qb940
UPDATE model_options SET model_restriction='{R,RWB,HD,HDWB,CP,CPW,TILT,TW}' WHERE id='27cc7f1e-beac-4dfd-8176-d8949cc1f233';  -- SYS qb320
UPDATE model_options SET model_restriction='{TILT,TW}' WHERE id='78740133-9300-4776-8782-6e34473c185a';  -- HKB qb310
UPDATE model_options SET model_restriction='{TILT,TW}' WHERE id='4bccb6b4-e5ba-483e-99bf-8005d2d62dc0';  -- LP qb1452
UPDATE model_options SET model_restriction='{R,RWB,HD,HDWB,CP,CPW,MX}' WHERE id='639108fc-8857-4428-90bf-c55c7f9493e4';  -- RH qb327
UPDATE model_options SET model_restriction='{R,RWB,HD,HDWB,CP,CPW,MX}' WHERE id='9fb9e526-1e03-46fb-9722-059030d8a416';  -- GP-CC qb1546
UPDATE model_options SET model_restriction='{R,RWB,HD,HDWB,CP,CPW,MX}' WHERE id='959f313d-15ef-4d19-a4a2-e0efcc9f2a37';  -- OS qb1288
UPDATE model_options SET model_restriction='{R,RWB,HD,HDWB,CP,CPW,MX}' WHERE id='5a2e2c93-1b59-4b18-a4d0-496330f03004';  -- OS-EXT qb1177
UPDATE model_options SET model_restriction='{TILT,TW}' WHERE id='0581bce2-c64b-43c7-a911-2aa7566f07b6';  -- WT-P qb1178
UPDATE model_options SET model_restriction='{R,RWB,HD,HDWB,CP,CPW,MX}' WHERE id='fc35b5b5-3893-4021-b0b9-b9684a9cd6b4';  -- HBB qb1482
UPDATE model_options SET model_restriction='{TILT,TW}' WHERE id='456b759c-dd7e-4247-ba0b-405d780cea07';  -- HDP qb342
UPDATE model_options SET model_restriction='{R,RWB,HD,HDWB,CP,CPW,MX}' WHERE id='bd50ed56-801b-4648-a7d3-64d45c017d88';  -- LD qb939
UPDATE model_options SET model_restriction='{HD,HDWB,CP,CPW,MX}' WHERE id='837aef68-8397-4b4a-9473-bf8cb4e97be1';  -- RF qb379
UPDATE model_options SET model_restriction='{R}' WHERE id='8ae10596-a7f2-4c78-9412-e6f1c43c876c';  -- HL qb318
UPDATE model_options SET model_restriction='{HDWB,CPW,TW}' WHERE id='54277864-a9e6-4edc-a9fb-9362c16cc1a6';  -- XP qb1453
-- (26 restriction changes)

-- C. Add 9 new options (idempotent on manufacturer_id+short_code)
INSERT INTO model_options (manufacturer_id, short_code, name, display_name, option_group, selection_type, retail_price, cost_price, margin_percent, qb_item_id, qb_item_name, model_restriction, allows_quantity, is_included, is_active, sort_order, notes)
SELECT 'b5cf513b-c38b-443e-bd13-8b2e79e1ccb6','HL-RWB','Hydraulic Lower Squeeze (Wide Body)','Hydraulic Lower Squeeze (Wide Body)','squeeze','pick_one',2175.0,1740.0,20.00,'801','Hydraulic Lower - Wide Body','{RWB}',false,false,true,5,'2026 price-list import; cost est. @20% margin (verify)'
WHERE NOT EXISTS (SELECT 1 FROM model_options WHERE manufacturer_id='b5cf513b-c38b-443e-bd13-8b2e79e1ccb6' AND short_code='HL-RWB');
INSERT INTO model_options (manufacturer_id, short_code, name, display_name, option_group, selection_type, retail_price, cost_price, margin_percent, qb_item_id, qb_item_name, model_restriction, allows_quantity, is_included, is_active, sort_order, notes)
SELECT 'b5cf513b-c38b-443e-bd13-8b2e79e1ccb6','XP-STD','Hydraulic Lower Squeeze Xtra Power (Std Width)','Hydraulic Lower Squeeze Xtra Power (Std Width)','squeeze','pick_one',1837.0,1469.6,20.00,'1454','Hydraulic Lower Squeeze Xtra Power Std Width','{HD,CP,TILT}',false,false,true,5,'2026 price-list import; cost est. @20% margin (verify)'
WHERE NOT EXISTS (SELECT 1 FROM model_options WHERE manufacturer_id='b5cf513b-c38b-443e-bd13-8b2e79e1ccb6' AND short_code='XP-STD');
INSERT INTO model_options (manufacturer_id, short_code, name, display_name, option_group, selection_type, retail_price, cost_price, margin_percent, qb_item_id, qb_item_name, model_restriction, allows_quantity, is_included, is_active, sort_order, notes)
SELECT 'b5cf513b-c38b-443e-bd13-8b2e79e1ccb6','HL-MX','MAXX Lower Squeeze','MAXX Lower Squeeze','squeeze','pick_one',2564.0,2051.2,20.00,'665','MAXX Lower squeeze','{MX}',false,false,true,5,'2026 price-list import; cost est. @20% margin (verify)'
WHERE NOT EXISTS (SELECT 1 FROM model_options WHERE manufacturer_id='b5cf513b-c38b-443e-bd13-8b2e79e1ccb6' AND short_code='HL-MX');
INSERT INTO model_options (manufacturer_id, short_code, name, display_name, option_group, selection_type, retail_price, cost_price, margin_percent, qb_item_id, qb_item_name, model_restriction, allows_quantity, is_included, is_active, sort_order, notes)
SELECT 'b5cf513b-c38b-443e-bd13-8b2e79e1ccb6','GP55','Gas Powered Hydraulic Pump (5.5 HP)','Gas Powered Hydraulic Pump (5.5 HP)','power','pick_one',2946.0,2356.8,20.00,'111','Gas Pump 6 HP','{TILT,TW}',false,false,true,70,'2026 price-list import; cost est. @20% margin (verify)'
WHERE NOT EXISTS (SELECT 1 FROM model_options WHERE manufacturer_id='b5cf513b-c38b-443e-bd13-8b2e79e1ccb6' AND short_code='GP55');
INSERT INTO model_options (manufacturer_id, short_code, name, display_name, option_group, selection_type, retail_price, cost_price, margin_percent, qb_item_id, qb_item_name, model_restriction, allows_quantity, is_included, is_active, sort_order, notes)
SELECT 'b5cf513b-c38b-443e-bd13-8b2e79e1ccb6','TT-PKG','TruTest Platform Scales w/ S3 Indicator','TruTest Platform Scales w/ S3 Indicator','scales','pick_one',4025.0,3220.0,20.00,'1547','TruTest Platform Scales with S3 Indicator','{R,RWB,HD,HDWB,CP,CPW,MX}',false,false,true,60,'2026 price-list import; cost est. @20% margin (verify)'
WHERE NOT EXISTS (SELECT 1 FROM model_options WHERE manufacturer_id='b5cf513b-c38b-443e-bd13-8b2e79e1ccb6' AND short_code='TT-PKG');
INSERT INTO model_options (manufacturer_id, short_code, name, display_name, option_group, selection_type, retail_price, cost_price, margin_percent, qb_item_id, qb_item_name, model_restriction, allows_quantity, is_included, is_active, sort_order, notes)
SELECT 'b5cf513b-c38b-443e-bd13-8b2e79e1ccb6','WT-PKG','Weigh-Tronix Platform Scales w/ 640 Indicator','Weigh-Tronix Platform Scales w/ 640 Indicator','scales','pick_one',3997.0,3197.6,20.00,'1548','Weigh-Tronix Platform Scales with 640 Indicator','{R,RWB,HD,HDWB,CP,CPW,MX}',false,false,true,60,'2026 price-list import; cost est. @20% margin (verify)'
WHERE NOT EXISTS (SELECT 1 FROM model_options WHERE manufacturer_id='b5cf513b-c38b-443e-bd13-8b2e79e1ccb6' AND short_code='WT-PKG');
INSERT INTO model_options (manufacturer_id, short_code, name, display_name, option_group, selection_type, retail_price, cost_price, margin_percent, qb_item_id, qb_item_name, model_restriction, allows_quantity, is_included, is_active, sort_order, notes)
SELECT 'b5cf513b-c38b-443e-bd13-8b2e79e1ccb6','SARG','Stand Alone Rear Gate','Stand Alone Rear Gate','misc','simple',3606.0,2884.8,20.00,'1516','Stand Alone Rear Gate','{TILT,TW}',false,false,true,54,'2026 price-list import; cost est. @20% margin (verify)'
WHERE NOT EXISTS (SELECT 1 FROM model_options WHERE manufacturer_id='b5cf513b-c38b-443e-bd13-8b2e79e1ccb6' AND short_code='SARG');
INSERT INTO model_options (manufacturer_id, short_code, name, display_name, option_group, selection_type, retail_price, cost_price, margin_percent, qb_item_id, qb_item_name, model_restriction, allows_quantity, is_included, is_active, sort_order, notes)
SELECT 'b5cf513b-c38b-443e-bd13-8b2e79e1ccb6','HLR','Hydraulic Leg Restraint','Hydraulic Leg Restraint','misc','simple',1920.0,1536.0,20.00,'1520','Hydraulic Leg Restraint','{TILT,TW}',false,false,true,55,'2026 price-list import; cost est. @20% margin (verify)'
WHERE NOT EXISTS (SELECT 1 FROM model_options WHERE manufacturer_id='b5cf513b-c38b-443e-bd13-8b2e79e1ccb6' AND short_code='HLR');
INSERT INTO model_options (manufacturer_id, short_code, name, display_name, option_group, selection_type, retail_price, cost_price, margin_percent, qb_item_id, qb_item_name, model_restriction, allows_quantity, is_included, is_active, sort_order, notes)
SELECT 'b5cf513b-c38b-443e-bd13-8b2e79e1ccb6','HCP','Hydraulic Calf Puller','Hydraulic Calf Puller','misc','simple',1944.0,1555.2,20.00,'1549','Hydraulic Calf Puller','{TILT,TW}',false,false,true,56,'2026 price-list import; cost est. @20% margin (verify)'
WHERE NOT EXISTS (SELECT 1 FROM model_options WHERE manufacturer_id='b5cf513b-c38b-443e-bd13-8b2e79e1ccb6' AND short_code='HCP');

COMMIT;
