import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDb, readSql, type TestDb } from './pg';
import { toCurrentPrice, toGood, toPort, toPortState, toShip, toUpgrade } from '../data/mappers';
import { planRoute } from '../domain/calculator';
import { suggestDestinations } from '../domain/suggest';
import type { CurrentPrice, Good, Port, PortState, Ship, Upgrade } from '../domain/types';

/**
 * The Phase 2 UI's data path, read as a logged-out visitor.
 *
 * Everything the product screens show arrives through two views —
 * prices_current and port_state_current — fetched from the browser with the
 * publishable key. Nothing else in the suite reads those two views as the anon
 * role, and a grant is a separate gate from a policy: a missing grant is a
 * "permission denied" that no amount of correct RLS will save.
 *
 * That exact blind spot has already cost this project once, when 202 tests
 * passed over a missing table grant. A view the whole UI depends on deserves
 * a test that reads it the way the browser will.
 */

let t: TestDb;

const SERVER = 'na';

let ports: Port[];
let ships: Ship[];
let goods: Good[];
let upgrades: Upgrade[];
let prices: CurrentPrice[];
let portStates: Map<string, PortState>;

beforeAll(async () => {
  t = await createTestDb({ seed: true });
  // Demo prices are what a brand-new visitor actually sees, so the cold-start
  // check below has to run against them rather than against invented rows.
  await t.db.exec(readSql('demo_prices.sql'));

  const rows = async (sql: string) => (await t.asAnon(sql)) as Record<string, unknown>[];

  ports = (await rows('select * from ports')).map(toPort);
  ships = (await rows('select * from ships')).map(toShip);
  goods = (await rows('select * from goods')).map(toGood);
  upgrades = (await rows('select * from upgrades')).map(toUpgrade);
  prices = (await rows(`select * from prices_current where server_id = '${SERVER}'`)).map(
    toCurrentPrice,
  );
  portStates = new Map(
    (await rows(`select * from port_state_current where server_id = '${SERVER}'`))
      .map(toPortState)
      .map((state) => [state.portId, state]),
  );
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe('a logged-out visitor can read everything the UI needs', () => {
  test('the reference data the pickers are built from', () => {
    expect(ports).toHaveLength(42);
    expect(ships).toHaveLength(38);
    expect(goods).toHaveLength(61);
    expect(upgrades).toHaveLength(20);
  });

  test('the server list, so the app can ask which economy to use', async () => {
    const servers = (await t.asAnon('select id from servers')) as { id: string }[];
    expect(servers.map((s) => s.id).sort()).toEqual(['asia', 'eu', 'na', 'ru']);
  });

  test('prices_current, which is the whole point of the tool', () => {
    expect(prices.length).toBeGreaterThan(0);
    // Every row must be scoped to the server that was asked for: two economies
    // mixed together produce garbage recommendations.
    expect(prices.every((price) => price.serverId === SERVER)).toBe(true);
  });

  test('port_state_current, which gates ports and supplies the tax', () => {
    expect(portStates.size).toBeGreaterThan(0);
  });

  test('demo rows arrive flagged as demo, so the UI can say so', () => {
    // The seeded prices are demo data. If this flag were lost in the view or
    // the mapper, the results screen would present invented numbers as real.
    expect(prices.some((price) => price.isDemo)).toBe(true);
  });

  test('unknown stock survives the round trip as null, not as zero', () => {
    // The Market screen shows no quantity for the 20 trade goods, so null
    // stock is the normal case and means "not shown", not "none left". A zero
    // arriving here would silently empty every cargo plan the tool produces.
    const unknownStock = prices.filter((price) => price.stock === null);
    expect(unknownStock.length).toBeGreaterThan(0);
    expect(prices.some((price) => price.stock === 0)).toBe(false);
  });
});

describe('cold start to a profit recommendation (SPEC 6 "Done when")', () => {
  test('some route in the demo data produces a non-empty cargo plan', () => {
    // This is the Phase 2 acceptance criterion, checked at the data layer: a
    // visitor who has entered nothing must still be able to reach a real
    // recommendation. It runs through the same calculator the screen uses.
    const ship = ships.find((candidate) => candidate.hold > 0);
    expect(ship).toBeDefined();

    let found: { origin: string; destination: string; profit: number } | null = null;

    for (const origin of ports) {
      const suggestions = suggestDestinations({
        serverId: SERVER,
        origin,
        originState: portStates.get(origin.id) ?? null,
        ship: ship!,
        ports,
        portStates,
        goods,
        prices,
        limit: 1,
      });
      if (suggestions.length === 0) continue;

      const destination = suggestions[0]!.port;
      const result = planRoute({
        serverId: SERVER,
        origin,
        destination,
        originState: portStates.get(origin.id) ?? null,
        destinationState: portStates.get(destination.id) ?? null,
        ship: ship!,
        goods,
        prices,
      });
      if (result.ok && result.plan.length > 0) {
        found = {
          origin: origin.id,
          destination: destination.id,
          profit: result.tripProfit,
        };
        break;
      }
    }

    expect(found, 'no profitable route exists in the demo data').not.toBeNull();
    expect(found!.profit).toBeGreaterThan(0);
  });
});
