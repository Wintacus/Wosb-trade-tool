-- =====================================================================
-- WOSB Trade Tool -- seed data.
--
-- GENERATED FILE. Do not edit by hand: run `npm run gen:sql` instead.
-- Source of truth is data/*.json, which carries the provenance and
-- confidence notes for every value.
--
-- Run this AFTER schema.sql, in the Supabase SQL Editor.
-- Safe to re-run: every insert upserts (inserts if new, updates if the id
-- already exists), and the assertions at the end re-check the row counts.
--
-- Money note: base_value, min_price and max_price are stored in TENTHS of
-- gold, matching price_submissions. The JSON holds whole gold, so those
-- three columns are multiplied by 10 here. Weights are untouched.
-- =====================================================================

-- Server regions are separate economies; prices never cross between them.
insert into servers (id, name) values
  ('na', 'North America'),
  ('eu', 'Europe'),
  ('ru', 'Russia'),
  ('asia', 'Asia')
on conflict (id) do update set name = excluded.name;

-- 42 ports. Coordinates are map pixels, meaningful only
-- as relative distance. Tax, docking fee, min ship rate, owner and level are
-- deliberately NOT seeded: they live in port_state, change with every guild
-- capture, and are unknown until a player observes them.
insert into ports (id, name, display_name, x, y, category) values
  ('assab', 'Assab', 'Assab', 97, 1211, 'k'),
  ('cursed_city', 'Cursed City', 'Cursed City', 101, 636, 'n'),
  ('al_khalif', 'Al-Khalif', 'Al-Khalif', 110, 1393, 'k'),
  ('nisogora', 'Nisogora', 'Nisogora', 166, 434, 'n'),
  ('nordberg', 'Nordberg', 'Nordberg', 217, 301, 'f'),
  ('west_bastion', 'West Bastion', 'West Bastion', 214, 818, 'n'),
  ('sharhat', 'Sharhat', 'Sharhat', 290, 1105, 'k'),
  ('oneg', 'Oneg', 'Oneg', 341, 121, 'n'),
  ('naabad_stronghold', 'Naabad Stronghold', 'Naabad Stronghold', 403, 676, 'p'),
  ('gelbion', 'Gelbion', 'Gelbion', 483, 342, 'n'),
  ('masadora', 'Masadora', 'Masadora', 499, 829, 'n'),
  ('devios', 'Devios', 'Devios', 540, 1177, 'n'),
  ('el_tigre', 'El Tigre', 'El Tigre', 552, 1364, 'f'),
  ('surako', 'Surako', 'Surako', 553, 529, 'f'),
  ('corsa_nois_bay', 'Corsa-Nois Bay', 'Corsa-Nois Bay', 672, 102, 'p'),
  ('bridgetown', 'Bridgetown', 'Bridgetown', 730, 836, 'n'),
  ('san_cristobel', 'San Cristobel', 'San Cristobel', 751, 1350, 'n'),
  ('charleston', 'Charleston', 'Charleston', 763, 986, 'n'),
  ('nevis', 'Nevis', 'Nevis', 826, 539, 'n'),
  ('pirate_city', 'Pirate City', 'Pirate City', 843, 1419, 'p'),
  ('everston', 'Everston', 'Everston', 867, 232, 'n'),
  ('laguna_blanco', 'Laguna Blanco', 'Laguna Blanco', 975, 969, 'n'),
  ('aruba', 'Aruba', 'Aruba', 1083, 354, 'n'),
  ('san_martinas', 'San Martinas', 'San Martinas', 1089, 1375, 'n'),
  ('tortuga', 'Tortuga', 'Tortuga', 1129, 771, 'p'),
  ('la_navidad', 'La Navidad', 'La Navidad', 1244, 918, 'n'),
  ('thermopylae', 'Thermopylae', 'Thermopylae', 1260, 617, 'n'),
  ('aldansk', 'Aldansk', 'Aldansk', 1274, 133, 'f'),
  ('south_bastion', 'South Bastion', 'South Bastion', 1297, 1287, 'n'),
  ('gray_island', 'Gray Island', 'Gray Island', 1343, 403, 'n'),
  ('st_john', 'St. John', 'St. Jean Bay', 1375, 1016, 'f'),
  ('fiji', 'Fiji', 'Fiji Bay', 1454, 747, 'n'),
  ('severoangelsk', 'Severoangelsk', 'Severoangelsk', 1463, 140, 'n'),
  ('bord_radel', 'Bord Radel', 'Port Bord Radel', 1528, 1400, 'n'),
  ('north_bastion', 'North Bastion', 'North Bastion', 1553, 355, 'n'),
  ('los_catuano', 'Los Catuano', 'Los Catuano Bay', 1582, 1162, 'n'),
  ('brandport', 'Brandport', 'Brandport Bay', 1641, 664, 'f'),
  ('santa_maria', 'Santa Maria', 'Santa Marta', 1716, 1021, 'f'),
  ('northside', 'Northside', 'Northside Cove', 1718, 201, 'n'),
  ('puerto_salada', 'Puerto Salada', 'Puerto Salada Bay', 1739, 1232, 'n'),
  ('freebooter_bay', 'Freebooter Bay', 'Freebooter Bay', 1763, 835, 'p'),
  ('freedom_bay', 'Freedom Bay', 'Freedom Bay', 1769, 508, 'f')
on conflict (id) do update set
  name = excluded.name, display_name = excluded.display_name,
  x = excluded.x, y = excluded.y, category = excluded.category;

-- 38 ships, transcribed from in-game shipyard stat cards.
-- speed is BASE speed: the game HUD shows base..maxCruise and cards show base.
-- upgrade_slots is null where it was not visible on the card -- null means
-- unknown, not zero.
insert into ships (id, name, class, hull_type, rate, durability, speed,
                   maneuverability, armor, hold, crew, upgrade_slots, verified) values
  ('huracan', 'Huracan', 'Imperial', 'Ship of the Line', 1, 8000, 5.5, 42, 11.5, 54000, 288, null, true),
  ('la_royale', 'La Royale', 'Siege', 'Galley', 1, 2900, 7.4, 83, 6.5, 24000, 156, null, true),
  ('12_apostolov', '12 Apostolov', 'Heavy', 'Ship of the Line', 1, 4400, 6.2, 49, 10, 36000, 220, null, true),
  ('la_couronne', 'La Couronne', 'Transport', 'Galleon', 1, 3500, 7.6, 72, 5.5, 50000, 188, null, true),
  ('victory', 'Victory', 'Battle', 'Ship of the Line', 1, 3740, 7.1, 66, 8, 25000, 204, null, true),
  ('octopus', 'Octopus', 'Imperial', 'Ship', 2, 2760, 8.3, 75, 6.8, 23000, 176, null, true),
  ('adventure', 'Adventure', 'Siege', 'Galley', 2, 2660, 8.2, 92, 5.2, 21000, 140, null, true),
  ('redoutable', 'Redoutable', 'Heavy', 'Ship of the Line', 2, 3540, 7, 57, 8, 30500, 198, null, true),
  ('la_sirene', 'La Sirene', 'Transport', 'Ship', 2, 2660, 8.1, 80, 4.4, 43000, 170, null, true),
  ('sans_pareil', 'Sans Pareil', 'Battle', 'Ship of the Line', 2, 3000, 7.7, 74, 6.4, 21500, 184, null, true),
  ('ingermanland', 'Ingermanland', 'Fast', 'Ship of the Line', 2, 2340, 9, 87, 3.2, 17500, 152, null, true),
  ('deadfish', 'Deadfish', 'Imperial', 'Ship', 3, 3000, 6.6, 66, 8, 27000, 166, null, true),
  ('kobukson', 'Kobukson', 'Siege', 'Phanokson', 3, 2000, 8, 85, 4.6, 18000, 124, null, true),
  ('bellona', 'Bellona', 'Heavy', 'Ship of the Line', 3, 3180, 7.5, 62, 7, 26000, 174, null, true),
  ('mordaunt', 'Mordaunt', 'Transport', 'Ship of the Line', 3, 2380, 8.7, 87, 3.9, 34000, 148, null, true),
  ('anson', 'Anson', 'Battle', 'Ship of the Line', 3, 2700, 8.2, 80, 5.6, 18500, 160, null, true),
  ('poltava', 'Poltava', 'Fast', 'Ship of the Line', 3, 2100, 9.6, 95, 2.8, 15500, 132, null, true),
  ('devourer', 'Devourer', 'Imperial', 'Barque', 4, 1760, 7.5, 110, 5.5, 17000, 144, null, true),
  ('constitution', 'Constitution', 'Heavy', 'Frigate', 4, 2560, 8, 68, 6, 21500, 148, null, true),
  ('falmouth', 'Falmouth', 'Transport', 'Ship', 4, 1920, 9.4, 96, 3.3, 27500, 126, null, true),
  ('essex', 'Essex', 'Battle', 'Frigate', 4, 2160, 8.9, 88, 4.8, 15500, 136, null, true),
  ('surprise', 'Surprise', 'Fast', 'Corvette', 4, 1680, 10.5, 105, 2.4, 13000, 112, null, true),
  ('black_prince', 'Black Prince', 'Imperial', 'Galleon', 5, 1700, 9.9, 90, 3, 14500, 120, null, true),
  ('le_requin', 'Le Requin', 'Siege', 'Xebec', 5, 1520, 9.6, 105, 3.2, 12500, 88, null, true),
  ('san_martin', 'San Martin', 'Heavy', 'Galleon', 5, 2140, 8.5, 72, 5, 17500, 126, null, true),
  ('russia', 'Russia', 'Transport', 'Frigate', 5, 1600, 9.9, 91, 2.7, 22000, 108, 8, true),
  ('black_wind', 'Black Wind', 'Battle', 'Frigate', 5, 1820, 9.4, 84, 4, 13000, 116, null, true),
  ('la_creole', 'La Creole', 'Fast', 'Corvette', 5, 1400, 11, 100, 2, 11000, 96, null, true),
  ('balloon', 'Balloon', 'Imperial', 'Montgolfiere', 6, 200, 21, 50, 1, 1000, 8, null, true),
  ('golden_apostle', 'Golden Apostle', 'Siege', 'Unknown', 6, 900, 9.5, 120, 2.2, 8500, 96, null, true),
  ('phoenix', 'Phoenix', 'Heavy', 'Brig', 6, 1380, 8.2, 75, 4.5, 12500, 104, null, true),
  ('polacca', 'Polacca', 'Siege', 'Polacca', 6, 980, 9, 102, 2.9, 9000, 74, 6, true),
  ('mercury', 'Mercury', 'Transport', 'Galleon', 6, 1040, 9.2, 89, 2.5, 15500, 88, null, true),
  ('la_salamandre', 'La Salamandre', 'Battle', 'Ketch', 6, 1160, 8.8, 82, 3.6, 9500, 96, null, true),
  ('le_cerf', 'Le Cerf', 'Fast', 'Cutter', 6, 900, 10, 97, 1.8, 8000, 78, 8, true),
  ('friede', 'Friede', 'Transport', 'Flute', 7, 750, 8.8, 86, 2.2, 11000, 72, 6, true),
  ('horizont', 'Horizont', 'Battle', 'Brigantine', 7, 850, 8.4, 80, 3.2, 7000, 78, 6, true),
  ('pickle', 'Pickle', 'Fast', 'Schooner', 7, 700, 9.2, 94, 1.6, 6000, 66, 6, true)
on conflict (id) do update set
  name = excluded.name, class = excluded.class, hull_type = excluded.hull_type,
  rate = excluded.rate, durability = excluded.durability, speed = excluded.speed,
  maneuverability = excluded.maneuverability, armor = excluded.armor,
  hold = excluded.hold, crew = excluded.crew,
  upgrade_slots = excluded.upgrade_slots, verified = excluded.verified;

-- 61 goods total: 20 trade goods
-- (is_trade_good = true) plus 26 craft materials and
-- 15 special items (is_trade_good = false).
-- min_price/max_price exist only for the 20 trade goods, where a price band
-- was actually observed. They are a sanity check on submissions, never a price.
insert into goods (id, name, weight, base_value, min_price, max_price,
                   is_trade_good, perishable, category) values
  ('beer', 'Beer', 6, 50, 50, 90, true, false, null),
  ('dates', 'Dates', 6, 80, 80, 140, true, false, null),
  ('grog', 'Grog', 5, 90, 90, 160, true, false, null),
  ('nuts', 'Nuts', 5, 90, 90, 160, true, false, null),
  ('wine', 'Wine', 3, 90, 90, 160, true, false, null),
  ('mango', 'Mango', 4, 110, 110, 190, true, false, null),
  ('pineapples', 'Pineapples', 4, 110, 110, 190, true, false, null),
  ('oil', 'Oil', 3, 130, 130, 220, true, false, null),
  ('paprika', 'Paprika', 9, 150, 150, 260, true, false, null),
  ('salt', 'Salt', 5, 180, 180, 310, true, false, null),
  ('leather', 'Leather', 5, 200, 200, 340, true, false, null),
  ('pepper', 'Pepper', 6, 210, 210, 360, true, false, null),
  ('vanilla', 'Vanilla', 7, 220, 220, 380, true, false, null),
  ('cinnamon', 'Cinnamon', 7, 230, 230, 390, true, false, null),
  ('rugs', 'Rugs', 6, 240, 240, 410, true, false, null),
  ('coffee', 'Coffee', 12, 250, 250, 430, true, false, null),
  ('sugar', 'Sugar', 20, 300, 300, 510, true, false, null),
  ('tobacco', 'Tobacco', 14, 320, 320, 550, true, false, null),
  ('saffron', 'Saffron', 15, 370, 370, 630, true, false, null),
  ('silk', 'Silk', 20, 520, 520, 880, true, false, null),
  ('wood', 'Wood', 2, 20, null, null, false, false, 'raw'),
  ('fabric', 'Fabric', 1, 30, null, null, false, false, 'processed'),
  ('iron', 'Iron', 4, 30, null, null, false, false, 'metal'),
  ('iron_ore', 'Iron Ore', 6, 30, null, null, false, false, 'ore'),
  ('water', 'Water', 2, 30, null, null, false, false, 'raw'),
  ('fresh_meat', 'Fresh Meat', 5, 40, null, null, false, true, 'food'),
  ('wreckage', 'Wreckage', 5, 50, null, null, false, false, 'raw'),
  ('fish', 'Fish', 3, 60, null, null, false, true, 'food'),
  ('rum', 'Rum', 6, 80, null, null, false, false, 'processed'),
  ('grain', 'Grain', 20, 80, null, null, false, true, 'food'),
  ('coal', 'Coal', 5, 100, null, null, false, false, 'raw'),
  ('whale_oil', 'Whale Oil', 15, 100, null, null, false, false, 'raw'),
  ('tackles', 'Tackles', 5, 120, null, null, false, false, 'processed'),
  ('animals', 'Animals', 22, 120, null, null, false, false, 'food'),
  ('supplies', 'Supplies', 5, 150, null, null, false, true, 'food'),
  ('copper_ore', 'Copper Ore', 25, 200, null, null, false, false, 'ore'),
  ('resin', 'Resin', 5, 200, null, null, false, false, 'processed'),
  ('copper', 'Copper', 10, 300, null, null, false, false, 'metal'),
  ('volcanic_ore', 'Volcanic Ore', 40, 300, null, null, false, false, 'ore'),
  ('captives', 'Captives', 60, 300, null, null, false, false, 'contraband'),
  ('provision', 'Provision', 40, 500, null, null, false, false, 'food'),
  ('canvas', 'Sailcloth', 10, 700, null, null, false, false, 'processed'),
  ('beam', 'Beam', 150, 2400, null, null, false, false, 'component'),
  ('bulkhead', 'Bulkhead', 210, 2800, null, null, false, false, 'component'),
  ('plate', 'Plate', 100, 3800, null, null, false, false, 'component'),
  ('bronze', 'Bronze', 90, 3900, null, null, false, false, 'metal'),
  ('amber', 'Amber', 5, 1000, null, null, false, false, 'luxury'),
  ('antiquities', 'Antiquities', 4, 200, null, null, false, false, 'luxury'),
  ('seahorse', 'Seahorse', 1, 10000, null, null, false, false, 'luxury'),
  ('voodoo_skull', 'Voodoo Skull', 7, 40000, null, null, false, false, 'luxury'),
  ('battle_mark', 'Battle Mark', 1, 2000, null, null, false, false, 'currency'),
  ('escudo', 'Escudo', 1, 20000, null, null, false, false, 'currency'),
  ('pirate_token', 'Pirate Token', 1, 1500, null, null, false, false, 'currency'),
  ('chest', 'Chest', 2, 5000, null, null, false, false, 'currency'),
  ('chest_key', 'Chest Key', 1, 250000, null, null, false, false, 'key'),
  ('blueprint_fragment', 'Blueprint Fragment', 1, 100000, null, null, false, false, 'blueprint'),
  ('imperial_blueprint', 'Imperial Blueprint', 1, 10000000, null, null, false, false, 'blueprint'),
  ('modification_blueprint', 'Modification Blueprint', 1, 100000, null, null, false, false, 'blueprint'),
  ('insurance', 'Insurance', 1, 600000, null, null, false, false, 'document'),
  ('construction_license', 'Construction License', 1, 4000000, null, null, false, false, 'document'),
  ('scrolls', 'Scrolls', 1, 500, null, null, false, false, 'document')
on conflict (id) do update set
  name = excluded.name, weight = excluded.weight, base_value = excluded.base_value,
  min_price = excluded.min_price, max_price = excluded.max_price,
  is_trade_good = excluded.is_trade_good, perishable = excluded.perishable,
  category = excluded.category;

-- 20 upgrades. Modifiers apply FLAT FIRST, THEN PERCENT --
-- an ordering verified against live in-game HUD values (ships.json
-- _meta.validationEvidence), not assumed.
--
-- Modifiers with no column in this schema are not seeded: item-loss,
-- sail efficiency, manoeuvrability, armour and crew. None affect trading
-- maths in V1. They are still in data/ships.json when they are needed.
insert into upgrades (id, name, category, hold_flat, hold_percent, speed_flat,
                      speed_percent, cruise_speed_flat, durability_flat,
                      durability_percent, upgrade_slots_flat, prevents_spoilage) values
  ('double_hold', 'Double Hold', 'cargo', 3000, 0, 0, 0, 0, 0, -5, 0, false),
  ('cellars', 'Cellars', 'cargo', 1500, 0, 0, 0, 0, 0, 0, 0, true),
  ('sturdy_frames', 'Sturdy Frames', 'cargo', 0, 12, 0, -15, 0, 0, 10, 0, false),
  ('lightweight_construction', 'Lightweight Construction', 'cargo', 0, 25, 0, 0, 0, 0, 0, 0, false),
  ('reinforced_masts', 'Reinforced Masts', 'speed', 0, 0, 0.6, 0, 0, 0, 0, 0, false),
  ('lightweight_hull', 'Lightweight Hull', 'speed', 0, 0, 0, 4, 0, 0, 0, 0, false),
  ('strong_beams', 'Strong Beams', 'speed', 0, 0, 0, -5, 0, 0, 5, 0, false),
  ('cheap_sails', 'Cheap Sails', 'sails', 0, 0, 0, 0, 2, 0, 0, 0, false),
  ('stitched_sails', 'Stitched Sails', 'sails', 0, 0, 0, 0, 2.4, 0, 0, 0, false),
  ('ultralight_sails', 'Ultra-light Sails', 'sails', 0, 0, 0, 0, 2.4, 0, 0, 0, false),
  ('storm_sails', 'Storm Sails', 'sails', 0, 0, 0, 0, 2.7, 0, 0, 0, false),
  ('elite_sails', 'Elite Sails', 'sails', 0, 0, 0, 0, 2.8, 0, 0, 0, false),
  ('tacking_sails', 'Tacking Sails', 'sails', 0, 0, 0, 0, 2.8, 0, 0, 0, false),
  ('reefed_sails', 'Reefed Sails', 'sails', 0, 0, 0, 0, 2.9, 0, 0, 0, false),
  ('tarpaulin_sails', 'Tarpaulin Sails', 'sails', 0, 0, 0, 0, 3.1, 0, 0, 0, false),
  ('raiding_sails', 'Raiding Sails', 'sails', 0, 0, 0, 0, 4.1, 0, 0, 0, false),
  ('structural_expansion', 'Structural Expansion', 'other', 0, 0, 0, 0, 0, 0, 0, 2, false),
  ('repair_arsenal', 'Repair Arsenal', 'other', 0, 0, 0, 0, 0, 80, 0, 0, false),
  ('teak_frames', 'Teak Frames', 'other', 0, 0, 0, 0, 0, 0, 0, 0, false),
  ('extra_bunks', 'Extra Bunks', 'other', 0, 0, 0, 0, 0, 0, 0, 0, false)
on conflict (id) do update set
  name = excluded.name, category = excluded.category,
  hold_flat = excluded.hold_flat, hold_percent = excluded.hold_percent,
  speed_flat = excluded.speed_flat, speed_percent = excluded.speed_percent,
  cruise_speed_flat = excluded.cruise_speed_flat,
  durability_flat = excluded.durability_flat,
  durability_percent = excluded.durability_percent,
  upgrade_slots_flat = excluded.upgrade_slots_flat,
  prevents_spoilage = excluded.prevents_spoilage;

-- ---------------------------------------------------------------------
-- Row count assertions (SPEC.md 3.3). If any of these fail the whole
-- script rolls back, so a short import cannot pass silently.
-- ---------------------------------------------------------------------
do $seed_check$
declare
  n integer;
begin
  select count(*) into n from ports;
  if n <> 42 then
    raise exception 'ports: expected 42 rows, found %', n;
  end if;
  select count(*) into n from ships;
  if n <> 38 then
    raise exception 'ships: expected 38 rows, found %', n;
  end if;
  select count(*) into n from goods where is_trade_good;
  if n <> 20 then
    raise exception 'goods (trade goods): expected 20 rows, found %', n;
  end if;
  select count(*) into n from goods where not is_trade_good;
  if n <> 41 then
    raise exception 'goods (craft + special): expected 41 rows, found %', n;
  end if;
  select count(*) into n from goods;
  if n <> 61 then
    raise exception 'goods (total): expected 61 rows, found %', n;
  end if;
  select count(*) into n from upgrades;
  if n <> 20 then
    raise exception 'upgrades: expected 20 rows, found %', n;
  end if;
  select count(*) into n from servers;
  if n <> 4 then
    raise exception 'servers: expected 4 rows, found %', n;
  end if;
  raise notice 'Seed OK: % ports, % ships, % goods (% trade, % other), % upgrades',
    42, 38, 61, 20, 41, 20;
end $seed_check$;
