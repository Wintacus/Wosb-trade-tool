import type { CurrentPrice, Good, Port, PortState, Ship } from '../domain/types';

/**
 * Test fixtures.
 *
 * These are deliberately synthetic. Real game values live in data/*.json and
 * are only used where a test is specifically about real observed data
 * (see the real-data regression test).
 */

export const SERVER = 'test';

export function makePort(id: string, x: number, y: number, overrides: Partial<Port> = {}): Port {
  return {
    id,
    name: id,
    displayName: id,
    x,
    y,
    category: 'n',
    ...overrides,
  };
}

export function makeShip(
  id: string,
  rate: number,
  hold: number,
  overrides: Partial<Ship> = {},
): Ship {
  return {
    id,
    name: id,
    shipClass: 'Transport',
    hullType: 'Ship',
    rate,
    durability: 1000,
    speed: 9,
    maneuverability: 80,
    armor: 3,
    hold,
    crew: 60,
    upgradeSlots: 6,
    verified: true,
    ...overrides,
  };
}

export function makeGood(id: string, weight: number, overrides: Partial<Good> = {}): Good {
  return {
    id,
    name: id,
    weight,
    baseValue: null,
    minPrice: null,
    maxPrice: null,
    isTradeGood: true,
    perishable: false,
    category: null,
    ...overrides,
  };
}

export function makePortState(
  portId: string,
  overrides: Partial<PortState> = {},
): PortState {
  return {
    portId,
    serverId: SERVER,
    taxPercent: null,
    dockingFee: null,
    minShipRate: null,
    controllingFaction: null,
    portLevel: null,
    portType: null,
    hasMarket: true,
    ...overrides,
  };
}

export function makePrice(
  portId: string,
  goodId: string,
  values: { buy?: number | null; sell?: number | null; stock?: number | null },
  overrides: Partial<CurrentPrice> = {},
): CurrentPrice {
  return {
    serverId: SERVER,
    portId,
    goodId,
    buyPrice: values.buy ?? null,
    sellPrice: values.sell ?? null,
    // Undefined and null mean different things here: `stock: null` is the
    // normal case for trade goods and means "quantity not shown in game".
    stock: values.stock === undefined ? null : values.stock,
    observedAt: '2026-08-23T00:00:00.000Z',
    isDemo: false,
    source: 'manual',
    ...overrides,
  };
}
