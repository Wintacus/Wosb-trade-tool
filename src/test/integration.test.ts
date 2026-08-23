import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { planTrip, type RouteSuccess } from '../domain/calculator';
import {
  toCurrentPrice,
  toGood,
  toPort,
  toPortState,
  toShip,
} from '../data/mappers';
import { createTestDb, readSql, type TestDb } from './pg';
import type { CurrentPrice, Good, Port, PortState, Ship } from '../domain/types';

/**
 * End to end: the real SQL files, loaded into a real Postgres, read back
 * through the real view, fed to the real calculator.
 *
 * Every earlier test exercises one layer. This one checks they fit together,
 * which is the part that actually breaks. It also demonstrates that the demo
 * data does what the file claims.
 */

let t: TestDb;
const SERVER = 'na';

async function rows(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const result = await t.db.query(sql, params as never[]);
  return result.rows as Record<string, unknown>[];
}

let ports: Map<string, Port>;
let goods: Good[];
let prices: CurrentPrice[];
let portStates: Map<string, PortState>;
let friede: Ship;

beforeAll(async () => {
  t = await createTestDb({ seed: true });
  await t.db.exec(readSql('demo_prices.sql'));

  ports = new Map((await rows('select * from ports')).map((r) => [String(r.id), toPort(r)]));
  goods = (await rows('select * from goods')).map(toGood);
  prices = (await rows('select * from prices_current where server_id = $1', [SERVER])).map(
    toCurrentPrice,
  );
  portStates = new Map(
    (await rows('select * from port_state where server_id = $1', [SERVER])).map((r) => {
      const state = toPortState(r);
      return [state.portId, state];
    }),
  );
  // The starter ship: rate 7, so no shallow-water limit can exclude it.
  friede = toShip((await rows(`select * from ships where id = 'friede'`))[0]!);
}, 120_000);

afterAll(async () => {
  await t?.close();
});

function trip(originId: string, destinationId: string, availableGold: number | null = null) {
  return planTrip({
    serverId: SERVER,
    origin: ports.get(originId)!,
    destination: ports.get(destinationId)!,
    originState: portStates.get(originId) ?? null,
    destinationState: portStates.get(destinationId) ?? null,
    ship: friede,
    goods,
    prices,
    availableGold,
  });
}

function ok(result: ReturnType<typeof trip>['outbound']): RouteSuccess {
  if (!result.ok) throw new Error(`Unexpected failure: ${result.code} ${result.message}`);
  return result;
}

describe('the data loads and maps correctly', () => {
  test('reference data comes back at the counts SPEC.md 3.3 requires', () => {
    expect(ports.size).toBe(42);
    expect(goods).toHaveLength(61);
    expect(goods.filter((g) => g.isTradeGood)).toHaveLength(20);
  });

  test('ship stats survive the round trip through Postgres numerics', () => {
    expect(friede.rate).toBe(7);
    expect(friede.hold).toBe(11_000);
    expect(friede.speed).toBe(8.8);
  });

  test('trade goods come back with null stock, which is the normal case', () => {
    const sugar = prices.find((p) => p.goodId === 'sugar' && p.portId === 'st_john')!;
    expect(sugar.stock).toBeNull();
    // Craft materials do show a quantity in game, so theirs is a real number.
    const wood = prices.find((p) => p.goodId === 'wood' && p.portId === 'st_john')!;
    expect(wood.stock).toBe(5000);
  });
});

describe('the profitable demo route', () => {
  const result = () => ok(trip('st_john', 'bord_radel').outbound);

  test('produces a cargo plan', () => {
    const plan = result();
    expect(plan.plan.length).toBeGreaterThan(0);
    expect(plan.tripProfit).toBeGreaterThan(0);
  });

  test('fills the hold without exceeding it', () => {
    const plan = result();
    expect(plan.totalWeightCarried).toBeLessThanOrEqual(plan.holdCapacity);
    expect(plan.holdCapacity).toBe(11_000);
  });

  test('applies the destination tax that was actually observed there', () => {
    const plan = result();
    // Port Bord Radel is recorded at 8%.
    expect(plan.unverified.taxUnknown).toBe(false);
    expect(plan.totalTax).toBeGreaterThan(0);
    expect(plan.totalTax).toBeGreaterThanOrEqual(Math.floor(plan.totalGrossRevenue * 0.08));
  });

  test('flags the demo prices and the unverified docking fee', () => {
    const plan = result();
    expect(plan.unverified.usesDemoPrices).toBe(true);
    expect(plan.unverified.dockingFeeUnverified).toBe(true);
    expect(plan.notes.join(' ')).toMatch(/demo data/i);
  });

  test('respects recorded stock on craft materials', () => {
    const plan = result();
    for (const line of plan.plan) {
      if (line.stock !== null) expect(line.quantity).toBeLessThanOrEqual(line.stock);
    }
  });

  test('a gold limit reduces the plan and stays affordable', () => {
    const rich = ok(trip('st_john', 'bord_radel').outbound);
    const poor = ok(trip('st_john', 'bord_radel', 5_000).outbound);
    expect(poor.totalPurchaseCost).toBeLessThanOrEqual(5_000);
    expect(poor.tripProfit).toBeLessThan(rich.tripProfit);
  });
});

describe('the deliberately unprofitable demo route', () => {
  test('Fiji Bay and Los Catuano Bay yield nothing in either direction', () => {
    // Both use the real prices observed in game, which differ by at most
    // 0.1 gold. The 8% tax swallows that, so the honest answer is nothing.
    const both = trip('fiji', 'los_catuano');
    expect(ok(both.outbound).plan).toHaveLength(0);
    expect(ok(both.returnLeg).plan).toHaveLength(0);
  });

  test('and says so rather than erroring', () => {
    const plan = ok(trip('fiji', 'los_catuano').outbound);
    expect(plan.emptyReason).toMatch(/not a failure|profitably/i);
  });
});

describe('rate gating uses the limits recorded on real ports', () => {
  test('a rate 3 ship cannot use Fiji Bay, which is shallow-water VI-7', () => {
    const bigShip: Ship = { ...friede, id: 'big', name: 'Big', rate: 3 };
    const result = planTrip({
      serverId: SERVER,
      origin: ports.get('fiji')!,
      destination: ports.get('st_john')!,
      originState: portStates.get('fiji') ?? null,
      destinationState: portStates.get('st_john') ?? null,
      ship: bigShip,
      goods,
      prices,
    });
    expect(result.outbound.ok).toBe(false);
    if (result.outbound.ok) return;
    expect(result.outbound.code).toBe('ship_cannot_use_origin');
    // Arriving is blocked just as departing is.
    expect(result.returnLeg.ok).toBe(false);
    if (result.returnLeg.ok) return;
    expect(result.returnLeg.code).toBe('ship_cannot_use_destination');
  });

  test('the rate 7 starter ship can use it', () => {
    expect(trip('fiji', 'st_john').outbound.ok).toBe(true);
  });
});

describe('a port with no recorded state', () => {
  test('Charleston reports tax as unknown rather than assuming a rate', () => {
    const plan = ok(trip('st_john', 'charleston').outbound);
    expect(portStates.has('charleston')).toBe(false);
    expect(plan.unverified.taxUnknown).toBe(true);
    expect(plan.totalTax).toBe(0);
    expect(plan.notes.join(' ')).toMatch(/tax .*unknown/i);
    // And it must not quietly claim the common 8%.
    expect(plan.notes.join(' ')).not.toMatch(/assum\w* 8%/i);
  });
});
