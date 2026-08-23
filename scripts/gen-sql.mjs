/**
 * Generates supabase/seed.sql from the JSON files in data/.
 *
 * The JSON files are the source of truth. This script only reshapes them --
 * it never supplies a value that is not in the source. Anything the source
 * leaves out stays NULL, because a null means "unknown" and a plausible
 * default would be an invented game value (CLAUDE.md hard rule 1).
 *
 * Re-run with:  npm run gen:sql
 * A test asserts the committed seed.sql matches what this produces, so the
 * two cannot drift apart.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => JSON.parse(readFileSync(join(root, 'data', name), 'utf8'));

const portsFile = read('ports.json');
const shipsFile = read('ships.json');
const goodsFile = read('goods.json');
const resourcesFile = read('resources.json');

/** SQL literal for a string, or NULL. */
const str = (v) =>
  v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`;

/** SQL literal for a number, or NULL. */
const num = (v) => (v === null || v === undefined || Number.isNaN(v) ? 'null' : String(v));

const bool = (v) => (v ? 'true' : 'false');

/**
 * Prices in the JSON are in whole gold as the game displays them. Everything
 * in this project stores money as integer TENTHS of gold, so that a price like
 * 4.2 needs no float. These reference bands are converted to match, otherwise
 * the sanity check would compare gold against tenths and reject real prices.
 */
const toTenths = (goldValue) =>
  goldValue === null || goldValue === undefined ? null : Math.round(goldValue * 10);

const lines = [];
const w = (line = '') => lines.push(line);

w('-- =====================================================================');
w('-- WOSB Trade Tool -- seed data.');
w('--');
w('-- GENERATED FILE. Do not edit by hand: run `npm run gen:sql` instead.');
w('-- Source of truth is data/*.json, which carries the provenance and');
w('-- confidence notes for every value.');
w('--');
w('-- Run this AFTER schema.sql, in the Supabase SQL Editor.');
w('-- Safe to re-run: every insert upserts (inserts if new, updates if the id');
w('-- already exists), and the assertions at the end re-check the row counts.');
w('--');
w('-- Money note: base_value, min_price and max_price are stored in TENTHS of');
w('-- gold, matching price_submissions. The JSON holds whole gold, so those');
w('-- three columns are multiplied by 10 here. Weights are untouched.');
w('-- =====================================================================');
w();

// ---------------------------------------------------------------------
// servers
// ---------------------------------------------------------------------
w('-- Server regions are separate economies; prices never cross between them.');
w('insert into servers (id, name) values');
w(
  [
    ['na', 'North America'],
    ['eu', 'Europe'],
    ['ru', 'Russia'],
    ['asia', 'Asia'],
  ]
    .map(([id, name]) => `  (${str(id)}, ${str(name)})`)
    .join(',\n') + '\non conflict (id) do update set name = excluded.name;',
);
w();

// ---------------------------------------------------------------------
// ports
// ---------------------------------------------------------------------
w(`-- ${portsFile.ports.length} ports. Coordinates are map pixels, meaningful only`);
w('-- as relative distance. Tax, docking fee, min ship rate, owner and level are');
w('-- deliberately NOT seeded: they live in port_state, change with every guild');
w('-- capture, and are unknown until a player observes them.');
w('insert into ports (id, name, display_name, x, y, category) values');
w(
  portsFile.ports
    .map(
      (p) =>
        `  (${str(p.id)}, ${str(p.name)}, ${str(p.displayName)}, ${num(p.x)}, ${num(p.y)}, ${str(p.category)})`,
    )
    .join(',\n') +
    '\non conflict (id) do update set\n' +
    '  name = excluded.name, display_name = excluded.display_name,\n' +
    '  x = excluded.x, y = excluded.y, category = excluded.category;',
);
w();

// ---------------------------------------------------------------------
// ships
// ---------------------------------------------------------------------
w(`-- ${shipsFile.ships.length} ships, transcribed from in-game shipyard stat cards.`);
w('-- speed is BASE speed: the game HUD shows base..maxCruise and cards show base.');
w('-- upgrade_slots is null where it was not visible on the card -- null means');
w('-- unknown, not zero.');
w('insert into ships (id, name, class, hull_type, rate, durability, speed,');
w('                   maneuverability, armor, hold, crew, upgrade_slots, verified) values');
w(
  shipsFile.ships
    .map(
      (s) =>
        `  (${str(s.id)}, ${str(s.name)}, ${str(s.class)}, ${str(s.hullType)}, ${num(s.rate)}, ` +
        `${num(s.durability)}, ${num(s.speed)}, ${num(s.maneuverability)}, ${num(s.armor)}, ` +
        `${num(s.hold)}, ${num(s.crew)}, ${num(s.upgradeSlots ?? null)}, ${bool(s.verified)})`,
    )
    .join(',\n') +
    '\non conflict (id) do update set\n' +
    '  name = excluded.name, class = excluded.class, hull_type = excluded.hull_type,\n' +
    '  rate = excluded.rate, durability = excluded.durability, speed = excluded.speed,\n' +
    '  maneuverability = excluded.maneuverability, armor = excluded.armor,\n' +
    '  hold = excluded.hold, crew = excluded.crew,\n' +
    '  upgrade_slots = excluded.upgrade_slots, verified = excluded.verified;',
);
w();

// ---------------------------------------------------------------------
// goods -- the 20 trade goods plus 41 craft materials and special items
// ---------------------------------------------------------------------
const goodRows = [];

for (const g of goodsFile.goods) {
  goodRows.push({
    id: g.id,
    name: g.name,
    weight: g.weight,
    baseValue: toTenths(g.baseValue),
    minPrice: toTenths(g.minPrice),
    maxPrice: toTenths(g.maxPrice),
    isTradeGood: true,
    perishable: g.perishable ?? false,
    // The trade-good table carries no category of its own; null means unknown.
    category: null,
  });
}

for (const m of resourcesFile.craftMaterials) {
  goodRows.push({
    id: m.id,
    name: m.name,
    weight: m.weight,
    baseValue: toTenths(m.baseValue),
    // No observed price band exists for craft materials, so no sanity range.
    minPrice: null,
    maxPrice: null,
    isTradeGood: false,
    perishable: m.perishable ?? false,
    category: m.category ?? null,
  });
}

for (const s of resourcesFile.specialItems) {
  goodRows.push({
    id: s.id,
    name: s.name,
    weight: s.weight,
    baseValue: toTenths(s.baseValue),
    minPrice: null,
    maxPrice: null,
    isTradeGood: false,
    // Spoilage is not recorded for special items; false is the source default.
    perishable: s.perishable ?? false,
    category: s.category ?? null,
  });
}

w(`-- ${goodRows.length} goods total: ${goodsFile.goods.length} trade goods`);
w(`-- (is_trade_good = true) plus ${resourcesFile.craftMaterials.length} craft materials and`);
w(`-- ${resourcesFile.specialItems.length} special items (is_trade_good = false).`);
w('-- min_price/max_price exist only for the 20 trade goods, where a price band');
w('-- was actually observed. They are a sanity check on submissions, never a price.');
w('insert into goods (id, name, weight, base_value, min_price, max_price,');
w('                   is_trade_good, perishable, category) values');
w(
  goodRows
    .map(
      (g) =>
        `  (${str(g.id)}, ${str(g.name)}, ${num(g.weight)}, ${num(g.baseValue)}, ` +
        `${num(g.minPrice)}, ${num(g.maxPrice)}, ${bool(g.isTradeGood)}, ` +
        `${bool(g.perishable)}, ${str(g.category)})`,
    )
    .join(',\n') +
    '\non conflict (id) do update set\n' +
    '  name = excluded.name, weight = excluded.weight, base_value = excluded.base_value,\n' +
    '  min_price = excluded.min_price, max_price = excluded.max_price,\n' +
    '  is_trade_good = excluded.is_trade_good, perishable = excluded.perishable,\n' +
    '  category = excluded.category;',
);
w();

// ---------------------------------------------------------------------
// upgrades
// ---------------------------------------------------------------------
const up = shipsFile.upgrades;
const upgradeRows = [];

const pushUpgrade = (u, category, overrides = {}) => {
  upgradeRows.push({
    id: u.id,
    name: u.name,
    category,
    holdFlat: u.hold ?? 0,
    holdPercent: u.holdPercent ?? 0,
    speedFlat: u.speedFlat ?? 0,
    speedPercent: u.speedPercent ?? 0,
    cruiseSpeedFlat: 0,
    durabilityFlat: u.durabilityFlat ?? 0,
    durabilityPercent: u.durabilityPercent ?? 0,
    upgradeSlotsFlat: u.upgradeSlots ?? 0,
    preventsSpoilage: u.preventsSpoilage ?? false,
    ...overrides,
  });
};

for (const u of up.cargo) pushUpgrade(u, 'cargo');
for (const u of up.speed) pushUpgrade(u, 'speed');
// Sails raise the CRUISE ceiling, not base speed, so they land in their own
// column and are never used in profit-per-distance (SPEC.md 5.4).
for (const u of up.sails.options) pushUpgrade(u, 'sails', { cruiseSpeedFlat: u.cruiseSpeed ?? 0 });
for (const u of up.other) pushUpgrade(u, 'other');

w(`-- ${upgradeRows.length} upgrades. Modifiers apply FLAT FIRST, THEN PERCENT --`);
w('-- an ordering verified against live in-game HUD values (ships.json');
w('-- _meta.validationEvidence), not assumed.');
w('--');
w('-- Modifiers with no column in this schema are not seeded: item-loss,');
w('-- sail efficiency, manoeuvrability, armour and crew. None affect trading');
w('-- maths in V1. They are still in data/ships.json when they are needed.');
w('insert into upgrades (id, name, category, hold_flat, hold_percent, speed_flat,');
w('                      speed_percent, cruise_speed_flat, durability_flat,');
w('                      durability_percent, upgrade_slots_flat, prevents_spoilage) values');
w(
  upgradeRows
    .map(
      (u) =>
        `  (${str(u.id)}, ${str(u.name)}, ${str(u.category)}, ${num(u.holdFlat)}, ` +
        `${num(u.holdPercent)}, ${num(u.speedFlat)}, ${num(u.speedPercent)}, ` +
        `${num(u.cruiseSpeedFlat)}, ${num(u.durabilityFlat)}, ${num(u.durabilityPercent)}, ` +
        `${num(u.upgradeSlotsFlat)}, ${bool(u.preventsSpoilage)})`,
    )
    .join(',\n') +
    '\non conflict (id) do update set\n' +
    '  name = excluded.name, category = excluded.category,\n' +
    '  hold_flat = excluded.hold_flat, hold_percent = excluded.hold_percent,\n' +
    '  speed_flat = excluded.speed_flat, speed_percent = excluded.speed_percent,\n' +
    '  cruise_speed_flat = excluded.cruise_speed_flat,\n' +
    '  durability_flat = excluded.durability_flat,\n' +
    '  durability_percent = excluded.durability_percent,\n' +
    '  upgrade_slots_flat = excluded.upgrade_slots_flat,\n' +
    '  prevents_spoilage = excluded.prevents_spoilage;',
);
w();

// ---------------------------------------------------------------------
// Assertions -- SPEC.md 3.3 requires these counts to be checked, not assumed.
// ---------------------------------------------------------------------
const tradeGoodCount = goodsFile.goods.length;
const otherGoodCount = resourcesFile.craftMaterials.length + resourcesFile.specialItems.length;

w('-- ---------------------------------------------------------------------');
w('-- Row count assertions (SPEC.md 3.3). If any of these fail the whole');
w('-- script rolls back, so a short import cannot pass silently.');
w('-- ---------------------------------------------------------------------');
w('do $seed_check$');
w('declare');
w('  n integer;');
w('begin');

const assertCount = (label, sql, expected) => {
  w(`  select count(*) into n from ${sql};`);
  w(`  if n <> ${expected} then`);
  w(`    raise exception '${label}: expected ${expected} rows, found %', n;`);
  w('  end if;');
};

assertCount('ports', 'ports', portsFile.ports.length);
assertCount('ships', 'ships', shipsFile.ships.length);
assertCount('goods (trade goods)', 'goods where is_trade_good', tradeGoodCount);
assertCount('goods (craft + special)', 'goods where not is_trade_good', otherGoodCount);
assertCount('goods (total)', 'goods', tradeGoodCount + otherGoodCount);
assertCount('upgrades', 'upgrades', upgradeRows.length);
assertCount('servers', 'servers', 4);

w("  raise notice 'Seed OK: % ports, % ships, % goods (% trade, % other), % upgrades',");
w(
  `    ${portsFile.ports.length}, ${shipsFile.ships.length}, ${tradeGoodCount + otherGoodCount}, ${tradeGoodCount}, ${otherGoodCount}, ${upgradeRows.length};`,
);
w('end $seed_check$;');
w();

writeFileSync(join(root, 'supabase', 'seed.sql'), lines.join('\n'), 'utf8');

console.log(
  `Wrote supabase/seed.sql: ${portsFile.ports.length} ports, ${shipsFile.ships.length} ships, ` +
    `${tradeGoodCount + otherGoodCount} goods, ${upgradeRows.length} upgrades.`,
);
