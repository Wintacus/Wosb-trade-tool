import type { CurrentPrice, Good, Port, PortState, Ship, Upgrade } from '../domain/types';

/**
 * Database rows to domain objects.
 *
 * Postgres `numeric` columns arrive as strings from some clients and numbers
 * from others, so every numeric field goes through `toNumber`. Nulls are
 * preserved throughout: a null means "unknown" and must never quietly become
 * a zero or a plausible default.
 */

type Row = Record<string, unknown>;

/**
 * A text column, or null when it is absent or null.
 *
 * The obvious ternary comparing only against null has a trap: an ABSENT key is
 * undefined, not null, so it falls through to the String() branch and produces
 * the literal text "undefined". That would then be shown as a port's
 * controlling faction or a ship's hull type, looking for all the world like
 * real data.
 */
function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requireNumber(value: unknown, field: string): number {
  const parsed = toNumber(value);
  if (parsed === null) throw new Error(`Expected a number for ${field}, got ${String(value)}`);
  return parsed;
}

export function toPort(row: Row): Port {
  return {
    id: String(row.id),
    name: String(row.name),
    displayName: toText(row.display_name),
    x: requireNumber(row.x, 'ports.x'),
    y: requireNumber(row.y, 'ports.y'),
    category: toText(row.category),
  };
}

export function toShip(row: Row): Ship {
  return {
    id: String(row.id),
    name: String(row.name),
    shipClass: String(row.class),
    hullType: toText(row.hull_type),
    rate: requireNumber(row.rate, 'ships.rate'),
    durability: toNumber(row.durability),
    speed: toNumber(row.speed),
    maneuverability: toNumber(row.maneuverability),
    armor: toNumber(row.armor),
    hold: requireNumber(row.hold, 'ships.hold'),
    crew: toNumber(row.crew),
    upgradeSlots: toNumber(row.upgrade_slots),
    verified: row.verified !== false,
  };
}

export function toGood(row: Row): Good {
  return {
    id: String(row.id),
    name: String(row.name),
    weight: requireNumber(row.weight, 'goods.weight'),
    baseValue: toNumber(row.base_value),
    minPrice: toNumber(row.min_price),
    maxPrice: toNumber(row.max_price),
    isTradeGood: row.is_trade_good === true,
    perishable: row.perishable === true,
    category: toText(row.category),
  };
}

export function toUpgrade(row: Row): Upgrade {
  return {
    id: String(row.id),
    name: String(row.name),
    category: toText(row.category),
    holdFlat: toNumber(row.hold_flat) ?? 0,
    holdPercent: toNumber(row.hold_percent) ?? 0,
    speedFlat: toNumber(row.speed_flat) ?? 0,
    speedPercent: toNumber(row.speed_percent) ?? 0,
    cruiseSpeedFlat: toNumber(row.cruise_speed_flat) ?? 0,
    durabilityFlat: toNumber(row.durability_flat) ?? 0,
    durabilityPercent: toNumber(row.durability_percent) ?? 0,
    upgradeSlotsFlat: toNumber(row.upgrade_slots_flat) ?? 0,
    preventsSpoilage: row.prevents_spoilage === true,
  };
}

export function toPortState(row: Row): PortState {
  return {
    portId: String(row.port_id),
    serverId: String(row.server_id),
    // Every one of these stays null when unknown. Tax especially: observed
    // real rates run from 4% to 12%, so there is no safe default.
    taxPercent: toNumber(row.tax_percent),
    dockingFee: toNumber(row.docking_fee),
    minShipRate: toNumber(row.min_ship_rate),
    controllingFaction: toText(row.controlling_faction),
    portLevel: toNumber(row.port_level),
    portType:
      row.port_type === 'city' || row.port_type === 'settlement' ? row.port_type : null,
    // null means nobody has recorded whether there is a market, which is not
    // the same as recording that there is none. Unknown defaults to usable.
    hasMarket: row.has_market !== false,
  };
}

export function toCurrentPrice(row: Row): CurrentPrice {
  return {
    serverId: String(row.server_id),
    portId: String(row.port_id),
    goodId: String(row.good_id),
    buyPrice: toNumber(row.buy_price),
    sellPrice: toNumber(row.sell_price),
    // Deliberately not `?? 0`: null stock means the game showed no quantity,
    // which the calculator treats as unbounded, not as empty.
    stock: toNumber(row.stock),
    observedAt: String(row.observed_at),
    isDemo: row.is_demo === true,
    source: String(row.source),
  };
}
