-- =====================================================================
-- WOSB Trade Tool -- demo prices (OPTIONAL).
--
-- GENERATED FILE. Do not edit by hand: run `npm run gen:sql` instead.
--
-- Run this LAST, after schema.sql and seed.sql. It is optional: skip it
-- and the app simply has no prices until you enter real ones.
--
-- Every price row here is is_demo = true and source = demo. The
-- prices_current view ignores a demo row for a (port, good) as soon as any
-- real submission exists for it, so real data always wins and nothing
-- needs cleaning up.
--
-- To remove the demo data entirely:
--   delete from price_submissions where is_demo and server_id = 'na';
--   delete from port_state_submissions where is_demo and server_id = 'na';
-- =====================================================================

-- ---------------------------------------------------------------------
-- Port state.
--
-- CAVEAT, read before trusting these: the tax rates and shallow-water
-- limits below are real values observed in game and recorded in
-- data/ports.json. What was never recorded is WHICH SERVER they were seen
-- on, so they are seeded for 'na' only and may be wrong for yours.
--
-- Because of that they ship as DEMO rows. The port_state_current view
-- drops a demo row for a port the moment anyone records a real observation
-- there, so a wrong seeded tax cannot outlive the first real sighting.
--
-- docking_fee stays null everywhere: it has never been observed at all.
-- Charleston deliberately gets no row, so the calculator has to say
-- "tax unknown" rather than assume a rate.
-- ---------------------------------------------------------------------
delete from port_state_submissions where is_demo and server_id = 'na';

insert into port_state_submissions
  (server_id, port_id, tax_percent, docking_fee, min_ship_rate,
   controlling_faction, port_level, port_type, has_market,
   submitted_by, source, is_demo, observed_at) values
  ('na', 'st_john', 12, null, null, null, null, 'settlement', true, null, 'demo', true, now()),
  ('na', 'bord_radel', 8, null, null, 'antilia', null, null, true, null, 'demo', true, now()),
  ('na', 'fiji', 8, null, 6, 'espaniol', null, 'city', true, null, 'demo', true, now()),
  ('na', 'los_catuano', 8, null, 6, 'espaniol', null, null, true, null, 'demo', true, now());

-- ---------------------------------------------------------------------
-- Prices. Clearing demo rows first keeps this file re-runnable without
-- piling up duplicates. Only demo rows are touched; real submissions are
-- never deleted, because the price history is what makes the data
-- trustworthy.
-- ---------------------------------------------------------------------
delete from price_submissions where is_demo and server_id = 'na';

insert into price_submissions
  (server_id, port_id, good_id, buy_price, sell_price, stock,
   submitted_by, source, is_demo, observed_at) values
  ('na', 'st_john', 'beer', 52, 52, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'beer', 88, 88, null, null, 'demo', true, now()),
  ('na', 'charleston', 'beer', 70, 70, null, null, 'demo', true, now()),
  ('na', 'fiji', 'beer', 70, 70, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'beer', 70, 70, null, null, 'demo', true, now()),
  ('na', 'st_john', 'dates', 82, 82, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'dates', 90, 90, null, null, 'demo', true, now()),
  ('na', 'charleston', 'dates', 135, 135, null, null, 'demo', true, now()),
  ('na', 'fiji', 'dates', 140, 140, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'dates', 140, 140, null, null, 'demo', true, now()),
  ('na', 'st_john', 'grog', 95, 95, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'grog', 155, 155, null, null, 'demo', true, now()),
  ('na', 'charleston', 'grog', 120, 120, null, null, 'demo', true, now()),
  ('na', 'fiji', 'grog', 120, 120, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'grog', 120, 120, null, null, 'demo', true, now()),
  ('na', 'st_john', 'nuts', 92, 92, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'nuts', 96, 96, null, null, 'demo', true, now()),
  ('na', 'charleston', 'nuts', 150, 150, null, null, 'demo', true, now()),
  ('na', 'fiji', 'nuts', 120, 120, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'nuts', 120, 120, null, null, 'demo', true, now()),
  ('na', 'st_john', 'wine', 95, 95, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'wine', 158, 158, null, null, 'demo', true, now()),
  ('na', 'charleston', 'wine', 130, 130, null, null, 'demo', true, now()),
  ('na', 'fiji', 'wine', 120, 120, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'wine', 120, 120, null, null, 'demo', true, now()),
  ('na', 'st_john', 'mango', 115, 115, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'mango', 120, 120, null, null, 'demo', true, now()),
  ('na', 'charleston', 'mango', 180, 180, null, null, 'demo', true, now()),
  ('na', 'fiji', 'mango', 190, 190, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'mango', 190, 190, null, null, 'demo', true, now()),
  ('na', 'st_john', 'pineapples', 118, 118, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'pineapples', 185, 185, null, null, 'demo', true, now()),
  ('na', 'charleston', 'pineapples', 140, 140, null, null, 'demo', true, now()),
  ('na', 'fiji', 'pineapples', 150, 150, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'pineapples', 150, 150, null, null, 'demo', true, now()),
  ('na', 'st_john', 'oil', 135, 135, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'oil', 215, 215, null, null, 'demo', true, now()),
  ('na', 'charleston', 'oil', 160, 160, null, null, 'demo', true, now()),
  ('na', 'fiji', 'oil', 170, 170, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'oil', 170, 170, null, null, 'demo', true, now()),
  ('na', 'st_john', 'paprika', 158, 158, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'paprika', 162, 162, null, null, 'demo', true, now()),
  ('na', 'charleston', 'paprika', 250, 250, null, null, 'demo', true, now()),
  ('na', 'fiji', 'paprika', 260, 260, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'paprika', 260, 260, null, null, 'demo', true, now()),
  ('na', 'st_john', 'salt', 185, 185, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'salt', 305, 305, null, null, 'demo', true, now()),
  ('na', 'charleston', 'salt', 220, 220, null, null, 'demo', true, now()),
  ('na', 'fiji', 'salt', 240, 240, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'salt', 230, 230, null, null, 'demo', true, now()),
  ('na', 'st_john', 'leather', 205, 205, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'leather', 210, 210, null, null, 'demo', true, now()),
  ('na', 'charleston', 'leather', 330, 330, null, null, 'demo', true, now()),
  ('na', 'fiji', 'leather', 270, 270, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'leather', 260, 260, null, null, 'demo', true, now()),
  ('na', 'st_john', 'pepper', 215, 215, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'pepper', 350, 350, null, null, 'demo', true, now()),
  ('na', 'charleston', 'pepper', 260, 260, null, null, 'demo', true, now()),
  ('na', 'fiji', 'pepper', 280, 280, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'pepper', 280, 280, null, null, 'demo', true, now()),
  ('na', 'st_john', 'vanilla', 225, 225, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'vanilla', 230, 230, null, null, 'demo', true, now()),
  ('na', 'charleston', 'vanilla', 370, 370, null, null, 'demo', true, now()),
  ('na', 'fiji', 'vanilla', 290, 290, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'vanilla', 290, 290, null, null, 'demo', true, now()),
  ('na', 'st_john', 'cinnamon', 235, 235, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'cinnamon', 385, 385, null, null, 'demo', true, now()),
  ('na', 'charleston', 'cinnamon', 300, 300, null, null, 'demo', true, now()),
  ('na', 'fiji', 'cinnamon', 390, 390, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'cinnamon', 390, 390, null, null, 'demo', true, now()),
  ('na', 'st_john', 'rugs', 245, 245, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'rugs', 250, 250, null, null, 'demo', true, now()),
  ('na', 'charleston', 'rugs', 400, 400, null, null, 'demo', true, now()),
  ('na', 'fiji', 'rugs', 410, 410, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'rugs', 410, 410, null, null, 'demo', true, now()),
  ('na', 'st_john', 'coffee', 255, 255, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'coffee', 425, 425, null, null, 'demo', true, now()),
  ('na', 'charleston', 'coffee', 320, 320, null, null, 'demo', true, now()),
  ('na', 'fiji', 'coffee', 330, 330, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'coffee', 330, 330, null, null, 'demo', true, now()),
  ('na', 'st_john', 'sugar', 305, 305, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'sugar', 310, 310, null, null, 'demo', true, now()),
  ('na', 'charleston', 'sugar', 500, 500, null, null, 'demo', true, now()),
  ('na', 'fiji', 'sugar', 400, 400, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'sugar', 390, 390, null, null, 'demo', true, now()),
  ('na', 'st_john', 'tobacco', 325, 325, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'tobacco', 540, 540, null, null, 'demo', true, now()),
  ('na', 'charleston', 'tobacco', 400, 400, null, null, 'demo', true, now()),
  ('na', 'fiji', 'tobacco', 420, 420, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'tobacco', 420, 420, null, null, 'demo', true, now()),
  ('na', 'st_john', 'saffron', 375, 375, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'saffron', 380, 380, null, null, 'demo', true, now()),
  ('na', 'charleston', 'saffron', 620, 620, null, null, 'demo', true, now()),
  ('na', 'fiji', 'saffron', 630, 630, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'saffron', 630, 630, null, null, 'demo', true, now()),
  ('na', 'st_john', 'silk', 530, 530, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'silk', 870, 870, null, null, 'demo', true, now()),
  ('na', 'charleston', 'silk', 650, 650, null, null, 'demo', true, now()),
  ('na', 'fiji', 'silk', 880, 880, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'silk', 880, 880, null, null, 'demo', true, now()),
  ('na', 'st_john', 'wood', 38, 35, 5000, null, 'demo', true, now()),
  ('na', 'bord_radel', 'wood', 50, 46, 4200, null, 'demo', true, now()),
  ('na', 'fiji', 'wood', 42, 39, 3800, null, 'demo', true, now()),
  ('na', 'st_john', 'rum', 130, 122, 400, null, 'demo', true, now()),
  ('na', 'bord_radel', 'rum', 158, 148, 260, null, 'demo', true, now()),
  ('na', 'fiji', 'rum', 141, 132, 310, null, 'demo', true, now()),
  ('na', 'st_john', 'resin', 430, 405, 120, null, 'demo', true, now()),
  ('na', 'bord_radel', 'resin', 505, 475, 80, null, 'demo', true, now()),
  ('na', 'fiji', 'resin', 460, 430, 95, null, 'demo', true, now()),
  ('na', 'st_john', 'copper', 195, 175, 300, null, 'demo', true, now()),
  ('na', 'bord_radel', 'copper', 245, 220, 210, null, 'demo', true, now()),
  ('na', 'fiji', 'copper', 220, 189, 260, null, 'demo', true, now()),
  ('na', 'st_john', 'water', 18, 8, 900, null, 'demo', true, now()),
  ('na', 'bord_radel', 'water', 25, 12, 640, null, 'demo', true, now()),
  ('na', 'fiji', 'water', 21, 9, 720, null, 'demo', true, now());

-- ---------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------
do $demo_check$
declare
  n integer;
begin
  select count(*) into n from price_submissions where is_demo and server_id = 'na';
  if n <> 115 then
    raise exception 'demo prices: expected 115 rows, found %', n;
  end if;

  -- Every demo row must be reachable through the view, since no real
  -- submissions exist yet to displace them.
  select count(*) into n from prices_current where is_demo and server_id = 'na';
  if n <> 115 then
    raise exception 'prices_current should expose all 115 demo rows, found %', n;
  end if;

  select count(*) into n from port_state_current where is_demo and server_id = 'na';
  if n <> 4 then
    raise exception 'port_state_current should expose 4 demo port rows, found %', n;
  end if;

  raise notice 'Demo OK: % price rows and % port rows, all flagged as demo', 115, 4;
end $demo_check$;
