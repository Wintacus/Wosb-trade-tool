/**
 * Generates supabase/demo_prices.sql.
 *
 * SPEC.md 3.4 wants clearly-labelled fake prices so the calculator is testable
 * before any real data exists. Every row written here is is_demo = true and
 * source = 'demo', which means the prices_current view drops it automatically
 * for a (port, good) the moment a real submission arrives. No cleanup job, no
 * chance of demo numbers quietly contaminating real results.
 *
 * The price table below is hand-built rather than generated, so each route
 * demonstrates something specific:
 *
 *   St. Jean Bay -> Port Bord Radel   a clearly profitable route
 *   Fiji Bay    <-> Los Catuano Bay   priced too similarly to profit either way
 *   anywhere     -> Charleston        no port_state row, so tax is unknown
 *
 * Re-run with:  npm run gen:sql
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SERVER = 'na';

const str = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const num = (v) => (v === null || v === undefined ? 'null' : String(v));

/**
 * Per-server port state.
 *
 * Tax rates and shallow-water limits here are values ports.json records as
 * actually observed in game. What is NOT recorded is which server they were
 * seen on, so they are seeded for one server only and should be re-checked in
 * game. Docking fee stays null everywhere: it has never been observed at all.
 */
const PORT_STATE = [
  // portId, tax%, dockingFee, minShipRate, faction, level, type
  ['st_john', 12, null, null, null, null, 'settlement'],
  ['bord_radel', 8, null, null, 'antilia', null, null],
  ['fiji', 8, null, 6, 'espaniol', null, 'city'],
  ['los_catuano', 8, null, 6, 'espaniol', null, null],
  // charleston deliberately has NO row, so the calculator has to report
  // "tax unknown" rather than quietly assuming a rate.
];

/**
 * Trade good prices, in tenths of gold.
 *
 * The game has only ever shown ONE number per trade good, so these demo rows
 * set buy_price and sell_price to the same value: profit comes from carrying a
 * good between ports, not from a spread within one port.
 *
 * fiji and los_catuano use the real prices observed in game and recorded in
 * goods.json _validationEvidence. They are seeded as demo rows only because
 * the server they were observed on was never recorded.
 *
 * Stock is null for every trade good, because the Market screen does not show
 * a quantity for them. That is the normal case, not missing data.
 */
const TRADE_PRICES = {
  //            st_john  bord_radel  charleston  fiji  los_catuano
  beer: [52, 88, 70, 70, 70],
  dates: [82, 90, 135, 140, 140],
  grog: [95, 155, 120, 120, 120],
  nuts: [92, 96, 150, 120, 120],
  wine: [95, 158, 130, 120, 120],
  mango: [115, 120, 180, 190, 190],
  pineapples: [118, 185, 140, 150, 150],
  oil: [135, 215, 160, 170, 170],
  paprika: [158, 162, 250, 260, 260],
  salt: [185, 305, 220, 240, 230],
  leather: [205, 210, 330, 270, 260],
  pepper: [215, 350, 260, 280, 280],
  vanilla: [225, 230, 370, 290, 290],
  cinnamon: [235, 385, 300, 390, 390],
  rugs: [245, 250, 400, 410, 410],
  coffee: [255, 425, 320, 330, 330],
  sugar: [305, 310, 500, 400, 390],
  tobacco: [325, 540, 400, 420, 420],
  saffron: [375, 380, 620, 630, 630],
  silk: [530, 870, 650, 880, 880],
};

const TRADE_PORTS = ['st_john', 'bord_radel', 'charleston', 'fiji', 'los_catuano'];

/**
 * Craft materials, which DO show a real buy/sell spread and a quantity in the
 * port trading house. The Fiji Bay column is the real observed spread recorded
 * in resources.json _meta.keyDifference.
 */
const CRAFT_PRICES = {
  //         st_john        bord_radel     fiji (observed)
  wood: [[38, 35, 5000], [50, 46, 4200], [42, 39, 3800]],
  rum: [[130, 122, 400], [158, 148, 260], [141, 132, 310]],
  resin: [[430, 405, 120], [505, 475, 80], [460, 430, 95]],
  copper: [[195, 175, 300], [245, 220, 210], [220, 189, 260]],
  water: [[18, 8, 900], [25, 12, 640], [21, 9, 720]],
};

const CRAFT_PORTS = ['st_john', 'bord_radel', 'fiji'];

const lines = [];
const w = (line = '') => lines.push(line);

w('-- =====================================================================');
w('-- WOSB Trade Tool -- demo prices (OPTIONAL).');
w('--');
w('-- GENERATED FILE. Do not edit by hand: run `npm run gen:sql` instead.');
w('--');
w('-- Run this LAST, after schema.sql and seed.sql. It is optional: skip it');
w('-- and the app simply has no prices until you enter real ones.');
w('--');
w('-- Every price row here is is_demo = true and source = demo. The');
w('-- prices_current view ignores a demo row for a (port, good) as soon as any');
w('-- real submission exists for it, so real data always wins and nothing');
w('-- needs cleaning up.');
w('--');
w('-- To remove the demo data entirely:');
w(`--   delete from price_submissions where is_demo and server_id = '${SERVER}';`);
w(`--   delete from port_state_submissions where is_demo and server_id = '${SERVER}';`);
w('-- =====================================================================');
w();

w('-- ---------------------------------------------------------------------');
w('-- Port state.');
w('--');
w('-- CAVEAT, read before trusting these: the tax rates and shallow-water');
w('-- limits below are real values observed in game and recorded in');
w('-- data/ports.json. What was never recorded is WHICH SERVER they were seen');
w(`-- on, so they are seeded for '${SERVER}' only and may be wrong for yours.`);
w('--');
w('-- Because of that they ship as DEMO rows. The port_state_current view');
w('-- drops a demo row for a port the moment anyone records a real observation');
w('-- there, so a wrong seeded tax cannot outlive the first real sighting.');
w('--');
w('-- docking_fee stays null everywhere: it has never been observed at all.');
w('-- Charleston deliberately gets no row, so the calculator has to say');
w('-- "tax unknown" rather than assume a rate.');
w('-- ---------------------------------------------------------------------');
w(`delete from port_state_submissions where is_demo and server_id = ${str(SERVER)};`);
w();
w('insert into port_state_submissions');
w('  (server_id, port_id, tax_percent, docking_fee, min_ship_rate,');
w('   controlling_faction, port_level, port_type, has_market,');
w('   submitted_by, source, is_demo, observed_at) values');
w(
  PORT_STATE.map(
    ([portId, tax, fee, minRate, faction, level, type]) =>
      `  (${str(SERVER)}, ${str(portId)}, ${num(tax)}, ${num(fee)}, ${num(minRate)}, ` +
      `${str(faction)}, ${num(level)}, ${str(type)}, true, null, 'demo', true, now())`,
  ).join(',\n') + ';',
);
w();

w('-- ---------------------------------------------------------------------');
w('-- Prices. Clearing demo rows first keeps this file re-runnable without');
w('-- piling up duplicates. Only demo rows are touched; real submissions are');
w('-- never deleted, because the price history is what makes the data');
w('-- trustworthy.');
w('-- ---------------------------------------------------------------------');
w(`delete from price_submissions where is_demo and server_id = ${str(SERVER)};`);
w();

const rows = [];

for (const [goodId, prices] of Object.entries(TRADE_PRICES)) {
  TRADE_PORTS.forEach((portId, i) => {
    const price = prices[i];
    // buy = sell: the game shows one number per trade good, and profit comes
    // from moving it, not from a spread inside a single port.
    // stock null: the Market screen shows no quantity for trade goods.
    rows.push([portId, goodId, price, price, null]);
  });
}

for (const [goodId, perPort] of Object.entries(CRAFT_PRICES)) {
  CRAFT_PORTS.forEach((portId, i) => {
    const [buy, sell, stock] = perPort[i];
    rows.push([portId, goodId, buy, sell, stock]);
  });
}

w('insert into price_submissions');
w('  (server_id, port_id, good_id, buy_price, sell_price, stock,');
w('   submitted_by, source, is_demo, observed_at) values');
w(
  rows
    .map(
      ([portId, goodId, buy, sell, stock]) =>
        `  (${str(SERVER)}, ${str(portId)}, ${str(goodId)}, ${num(buy)}, ${num(sell)}, ` +
        `${num(stock)}, null, 'demo', true, now())`,
    )
    .join(',\n') + ';',
);
w();

w('-- ---------------------------------------------------------------------');
w('-- Assertions.');
w('-- ---------------------------------------------------------------------');
w('do $demo_check$');
w('declare');
w('  n integer;');
w('begin');
w(`  select count(*) into n from price_submissions where is_demo and server_id = ${str(SERVER)};`);
w(`  if n <> ${rows.length} then`);
w(`    raise exception 'demo prices: expected ${rows.length} rows, found %', n;`);
w('  end if;');
w();
w('  -- Every demo row must be reachable through the view, since no real');
w('  -- submissions exist yet to displace them.');
w(`  select count(*) into n from prices_current where is_demo and server_id = ${str(SERVER)};`);
w(`  if n <> ${rows.length} then`);
w(`    raise exception 'prices_current should expose all ${rows.length} demo rows, found %', n;`);
w('  end if;');
w();
w(`  select count(*) into n from port_state_current where is_demo and server_id = ${str(SERVER)};`);
w(`  if n <> ${PORT_STATE.length} then`);
w(`    raise exception 'port_state_current should expose ${PORT_STATE.length} demo port rows, found %', n;`);
w('  end if;');
w();
w(`  raise notice 'Demo OK: % price rows and % port rows, all flagged as demo', ${rows.length}, ${PORT_STATE.length};`);
w('end $demo_check$;');
w();

writeFileSync(join(root, 'supabase', 'demo_prices.sql'), lines.join('\n'), 'utf8');

console.log(
  `Wrote supabase/demo_prices.sql: ${rows.length} demo price rows, ` +
    `${PORT_STATE.length} port_state rows.`,
);
