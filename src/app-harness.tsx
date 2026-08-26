import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { Results } from './ui/Results';
import { ShipPicker } from './ui/ShipPicker';
import { planTrip } from './domain/calculator';
import { toPort, toShip } from './data/mappers';
import { makeGood, makePortState, makePrice, makeShip } from './test/fixtures';
import type { ShipPreset } from './lib/prefs';
import type { CurrentPrice, Good, Port, Ship, Upgrade } from './domain/types';
import portsFile from '../data/ports.json';
import shipsFile from '../data/ships.json';
import goodsFile from '../data/goods.json';

/**
 * A dev-only harness for driving the NON-MAP screens under a real browser.
 *
 * The map got one of these after a phone user found four bugs that 390 unit
 * tests could not see, all of them layout or touch bugs. Results and the ship
 * picker have never been opened in a browser at all. This page mounts them at
 * phone width with fixture data so `scripts/ui-test.mjs` can measure real
 * boxes, tap real controls and take real screenshots.
 *
 * ?screen=results            the results screen, everything verified
 * ?screen=results&data=unverified
 *                            unknown tax, unverified docking fee, demo prices
 *                            and an unverified ship, so every caveat renders
 * ?screen=ships              the ship and preset picker
 *
 * Never part of the production site: Vite's build input is index.html alone,
 * so this page exists only under `vite dev`.
 *
 * PRICES HERE ARE SYNTHETIC (src/test/fixtures.ts, deliberately fake). Ports,
 * ships, goods, weights and upgrades are the real rows from data/*.json.
 * Nothing on this page should ever be read as an observed game value.
 */

type Row = Record<string, unknown>;

/** Index access is checked in this project; the harness data is fixed and known. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`harness fixture is missing ${what}`);
  return value;
}

/** A fixed clock, so freshness badges and screenshots do not drift by run. */
const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);
const FRESH = new Date(NOW - 25 * 60 * 1000).toISOString();
const OLD = new Date(NOW - 30 * 60 * 60 * 1000).toISOString();

const ports: Port[] = (portsFile as { ports: Row[] }).ports.map(toPort);

const ships: Ship[] = (shipsFile as { ships: Row[] }).ships.map((row) => ({
  ...toShip(row),
  // data/ships.json is camelCase; the mapper reads the database's snake_case.
  hullType: typeof row.hullType === 'string' ? row.hullType : null,
  upgradeSlots: typeof row.upgradeSlots === 'number' ? row.upgradeSlots : null,
}));

const upgrades: Upgrade[] = Object.entries(
  (shipsFile as { upgrades: Record<string, unknown> }).upgrades,
).flatMap(([category, rows]) =>
  !Array.isArray(rows)
    ? []
    : (rows as Row[]).map((row) => ({
        id: String(row.id),
        name: String(row.name),
        category: category[0]!.toUpperCase() + category.slice(1),
        holdFlat: typeof row.hold === 'number' ? row.hold : 0,
        holdPercent: typeof row.holdPercent === 'number' ? row.holdPercent : 0,
        speedFlat: typeof row.speedFlat === 'number' ? row.speedFlat : 0,
        speedPercent: typeof row.speedPercent === 'number' ? row.speedPercent : 0,
        cruiseSpeedFlat: 0,
        durabilityFlat: typeof row.durabilityFlat === 'number' ? row.durabilityFlat : 0,
        durabilityPercent: typeof row.durabilityPercent === 'number' ? row.durabilityPercent : 0,
        upgradeSlotsFlat: typeof row.upgradeSlots === 'number' ? row.upgradeSlots : 0,
        preventsSpoilage: row.preventsSpoilage === true,
      })),
);

/** Real ids, names and weights; everything about price is invented below. */
const goods: Good[] = (goodsFile as { goods: Row[] }).goods.map((row) =>
  makeGood(String(row.id), Number(row.weight), { name: String(row.name) }),
);

const origin = must(ports[0], 'a first port');
// The longest label on the map, on purpose: long names are what clip.
const destination = must(
  [...ports]
    .slice(1)
    .sort((a, b) => (b.displayName ?? b.name).length - (a.displayName ?? a.name).length)[0],
  'a destination port',
);

/** A mid-sized real hull, so the plan is neither one line nor forty. */
const ship = must(
  [...ships].sort((a, b) => a.hold - b.hold)[Math.floor(ships.length / 2)],
  'a mid-sized ship',
);
/**
 * Every one of the 38 real ships is verified, so the unverified-stats caveat
 * cannot be produced from real data at all. This hull is openly synthetic —
 * a fixture, not a claim about any ship in the game (CLAUDE.md rule 1).
 */
const unverifiedShip: Ship = makeShip('harness-unverified-hull', ship.rate, ship.hold, {
  name: 'Unverified test hull',
  verified: false,
});

/**
 * Synthetic prices, arranged so the table has something of every kind in it:
 * goods that make the plan, goods that lose money, goods with no price at one
 * end, and one that is out of stock. Deterministic — no randomness, so a
 * screenshot diff means a real change.
 */
function fixturePrices(demo: boolean): CurrentPrice[] {
  const rows: CurrentPrice[] = [];
  goods.forEach((good, i) => {
    const buy = 100 + i * 37;
    const margin = i % 7 === 3 ? -30 : 20 + ((i * 13) % 70);
    const hasBuy = i % 9 !== 4;
    const hasSell = i % 5 !== 0;
    // Stocks are finite for most goods so the plan spans several of them. A
    // couple are null — "quantity not shown in game", the normal case for a
    // trade good — and one is a real zero, so the table has an out-of-stock row.
    const stock = i % 6 === 2 ? 0 : i % 7 === 5 ? null : 380 + i * 40;
    const observedAt = demo && i % 3 === 0 ? OLD : FRESH;
    if (hasBuy) {
      rows.push(
        makePrice(origin.id, good.id, { buy, stock }, {
          serverId: 'harness',
          observedAt,
          isDemo: demo,
        }),
      );
    }
    if (hasSell) {
      rows.push(
        makePrice(destination.id, good.id, { sell: buy + margin }, {
          serverId: 'harness',
          observedAt,
          isDemo: demo,
        }),
      );
    }
  });
  return rows;
}

function ResultsHarness({ unverified }: { unverified: boolean }) {
  const originState = makePortState(origin.id, {
    serverId: 'harness',
    taxPercent: unverified ? null : 5,
    dockingFee: unverified ? null : 0,
  });
  const destinationState = makePortState(destination.id, {
    serverId: 'harness',
    taxPercent: unverified ? null : 5,
    dockingFee: unverified ? null : 0,
  });
  const prices = fixturePrices(unverified);
  const trip = planTrip({
    serverId: 'harness',
    origin,
    destination,
    originState,
    destinationState,
    ship: unverified ? unverifiedShip : ship,
    goods,
    prices,
  });

  return (
    <Results
      trip={trip}
      goods={goods}
      prices={prices}
      originState={originState}
      destinationState={destinationState}
      originName={origin.displayName ?? origin.name}
      destinationName={destination.displayName ?? destination.name}
      suggestions={[]}
      now={NOW}
      onPickSuggestion={() => {}}
      onChangeRoute={() => {}}
      onAddData={() => {}}
    />
  );
}

function ShipsHarness() {
  const [presets, setPresets] = useState<ShipPreset[]>([]);
  const [selection, setSelection] = useState<{ shipId: string | null; presetId: string | null }>({
    shipId: null,
    presetId: null,
  });
  return (
    <ShipPicker
      ships={ships}
      upgrades={upgrades}
      presets={presets}
      onPresetsChange={setPresets}
      selectedShipId={selection.shipId}
      selectedPresetId={selection.presetId}
      onSelect={(choice) => setSelection({ shipId: choice.shipId, presetId: choice.presetId })}
    />
  );
}

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const screen = params.get('screen') ?? 'results';
  // The same shell App.tsx puts every screen inside, because the padding and
  // max width are half of what decides whether a screen overflows sideways.
  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-5 px-4 py-6 sm:px-6">
        {screen === 'ships' ? <ShipsHarness /> : (
          <ResultsHarness unverified={params.get('data') === 'unverified'} />
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
