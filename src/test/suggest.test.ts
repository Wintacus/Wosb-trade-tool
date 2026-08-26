import { describe, expect, it } from 'vitest';
import { suggestDestinations } from '../domain/suggest';
import { planRoute } from '../domain/calculator';
import type { Port, PortState } from '../domain/types';
import { SERVER, makeGood, makePort, makePortState, makePrice, makeShip } from './fixtures';

const origin = makePort('origin', 0, 0);
const near = makePort('near', 30, 0);
const far = makePort('far', 300, 0);
const barren = makePort('barren', 10, 0);

const ports: Port[] = [origin, near, far, barren];
const goods = [makeGood('rum', 5), makeGood('silk', 10)];
const ship = makeShip('fluyt', 5, 500);

function states(overrides: Record<string, Partial<PortState>> = {}): Map<string, PortState> {
  const map = new Map<string, PortState>();
  for (const port of ports) {
    map.set(port.id, makePortState(port.id, overrides[port.id] ?? {}));
  }
  return map;
}

const prices = [
  makePrice('origin', 'rum', { buy: 100 }),
  makePrice('origin', 'silk', { buy: 200 }),
  makePrice('near', 'rum', { sell: 150 }),
  makePrice('far', 'rum', { sell: 900 }),
  makePrice('far', 'silk', { sell: 900 }),
  makePrice('barren', 'rum', { sell: 40 }),
];

function suggest(extra: Partial<Parameters<typeof suggestDestinations>[0]> = {}) {
  return suggestDestinations({
    serverId: SERVER,
    origin,
    originState: makePortState('origin'),
    ship,
    ports,
    portStates: states(),
    goods,
    prices,
    ...extra,
  });
}

describe('nearest profitable destination (SPEC 6.6)', () => {
  it('suggests the nearest port that is actually profitable', () => {
    const results = suggest();
    expect(results[0]!.port.id).toBe('near');
    expect(results[0]!.distanceUnits).toBeGreaterThan(0);
  });

  it('skips a port where every good would lose money', () => {
    // Barren is closer than either, and selling rum there is a loss. A hint
    // that sends someone sailing for nothing is worse than no hint.
    expect(suggest().map((s) => s.port.id)).not.toContain('barren');
  });

  it('never suggests the origin, nor a port the caller ruled out', () => {
    const results = suggest({ exclude: ['near'] });
    expect(results.map((s) => s.port.id)).toEqual(['far']);
  });

  it('agrees with the calculator about which ports produce a plan', () => {
    // The screen is a shortcut around the knapsack, so it has to reach the
    // same verdict the real solver would. Anything else is a lie in a hint.
    const portStates = states();
    for (const port of [near, far, barren]) {
      const suggested = suggest().some((s) => s.port.id === port.id);
      const planned = planRoute({
        serverId: SERVER,
        origin,
        destination: port,
        originState: portStates.get('origin')!,
        destinationState: portStates.get(port.id)!,
        ship,
        goods,
        prices,
      });
      const hasPlan = planned.ok && planned.plan.length > 0;
      expect(suggested).toBe(hasPlan);
    }
  });

  it('respects the rate gate at the destination', () => {
    // The rate-5 ship is too big for a port that admits only rate 6 and 7.
    const results = suggest({ portStates: states({ near: { minShipRate: 6 } }) });
    expect(results.map((s) => s.port.id)).toEqual(['far']);
  });

  it('returns nothing at all when the ship cannot even leave the origin', () => {
    // Departure is gated too, so no destination can rescue this.
    const results = suggest({ originState: makePortState('origin', { minShipRate: 6 }) });
    expect(results).toEqual([]);
  });

  it('skips a destination with no market', () => {
    const results = suggest({ portStates: states({ near: { hasMarket: false } }) });
    expect(results.map((s) => s.port.id)).toEqual(['far']);
  });

  it('accounts for destination tax, which can erase a thin margin', () => {
    // Rum bought at 100 and sold at 150 clears 50 before tax and nothing at
    // all at 40%. Ignoring tax here would recommend a loss-making trip.
    const results = suggest({ portStates: states({ near: { taxPercent: 40 } }) });
    expect(results.map((s) => s.port.id)).toEqual(['far']);
  });

  it('honours a gold limit that cannot afford a single unit', () => {
    expect(suggest({ availableGold: 50 })).toEqual([]);
  });

  it('ignores goods too heavy for the hold', () => {
    const tiny = makeShip('skiff', 7, 6);
    const results = suggest({ ship: tiny });
    // Only rum (weight 5) fits a hold of 6; silk does not.
    expect(results.every((s) => s.profitableGoods <= 1)).toBe(true);
  });

  it('ignores a good recorded as out of stock at the origin', () => {
    const withoutRum = prices.map((p) =>
      p.portId === 'origin' && p.goodId === 'rum' ? { ...p, stock: 0 } : p,
    );
    const results = suggest({ prices: withoutRum });
    // Rum is unavailable, so only the port that also buys silk qualifies.
    expect(results.map((s) => s.port.id)).toEqual(['far']);
  });

  it('reports demo prices as demo, so a hint is never dressed up as real data', () => {
    const demo = prices.map((p) => ({ ...p, isDemo: true }));
    expect(suggest({ prices: demo }).every((s) => s.usesDemoPrices)).toBe(true);
    expect(suggest().every((s) => !s.usesDemoPrices)).toBe(true);
  });

  it('ignores another server entirely', () => {
    // Servers are separate economies; mixing them produces garbage.
    const elsewhere = prices.map((p) => ({ ...p, serverId: 'other' }));
    expect(suggest({ prices: elsewhere })).toEqual([]);
  });

  it('limits how many it returns', () => {
    expect(suggest({ limit: 1 })).toHaveLength(1);
  });
});
