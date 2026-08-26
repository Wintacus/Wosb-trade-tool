import { canUsePort, portDistance } from './geo';
import { taxToBasisPoints, unitValueScaled } from './money';
import { effectiveShipStats, usableHold } from './ships';
import type { CurrentPrice, Good, Port, PortState, Ship, Upgrade } from './types';

/**
 * "No profitable goods on this route — but here is the nearest port that is."
 *
 * SPEC.md 6.6 requires that suggestion, and it has to be cheap: running the
 * full knapsack against all 41 other ports would mean up to 41 solves, and one
 * solve at the largest hold takes about 71ms. Several seconds of a frozen phone
 * is not an acceptable price for a hint.
 *
 * The shortcut is exact for the question actually being asked. A cargo plan is
 * non-empty exactly when at least one good has a positive per-unit profit after
 * tax and fits the hold — the optimiser decides *quantities*, not whether
 * anything qualifies at all. So screening on per-unit profit finds precisely the
 * ports that would produce a non-empty plan, without solving any of them.
 *
 * What it does NOT claim is how much those ports pay. It answers "somewhere to
 * go", and the real number arrives when the user picks one and the calculator
 * runs properly.
 */
export interface DestinationSuggestion {
  port: Port;
  distanceUnits: number;
  /** How many goods clear a profit per unit. A count, never a profit figure. */
  profitableGoods: number;
  /** True when every price involved is seeded demo data. */
  usesDemoPrices: boolean;
  /** The most recent observation backing this suggestion, for freshness. */
  observedAt: string | null;
}

export interface SuggestInput {
  serverId: string;
  origin: Port;
  originState: PortState | null;
  ship: Ship;
  upgrades?: readonly Upgrade[];
  ports: readonly Port[];
  portStates: ReadonlyMap<string, PortState>;
  goods: readonly Good[];
  /** Every current price on this server, both ports of every candidate. */
  prices: readonly CurrentPrice[];
  availableGold?: number | null;
  /** Ports already ruled out — normally the destination the user just tried. */
  exclude?: readonly string[];
  limit?: number;
}

function priceKey(portId: string, goodId: string): string {
  return `${portId} ${goodId}`;
}

/**
 * Nearest-first list of destinations where at least one good turns a profit.
 *
 * Returns an empty array rather than a fallback when nothing qualifies: no
 * profitable port anywhere is a real answer, and inventing a "best of a bad
 * lot" would send someone sailing for nothing.
 */
export function suggestDestinations(input: SuggestInput): DestinationSuggestion[] {
  const { serverId, origin, originState, ship, goods } = input;
  const limit = input.limit ?? 3;
  const excluded = new Set([origin.id, ...(input.exclude ?? [])]);

  // The origin gates departure just as a destination gates arrival, so if the
  // ship cannot undock here, no destination helps (SPEC 4.1).
  if (!canUsePort(ship.rate, originState?.minShipRate ?? null)) return [];
  if (originState && !originState.hasMarket) return [];

  const capacity = usableHold(effectiveShipStats(ship, input.upgrades ?? []));
  if (capacity <= 0) return [];

  const availableGold =
    input.availableGold != null && Number.isFinite(input.availableGold) && input.availableGold >= 0
      ? input.availableGold
      : null;

  const priceIndex = new Map<string, CurrentPrice>();
  for (const price of input.prices) {
    if (price.serverId !== serverId) continue;
    priceIndex.set(priceKey(price.portId, price.goodId), price);
  }

  // Goods that can actually leave the origin, resolved once rather than per
  // candidate port: the buy side does not change as the destination does.
  const buyable: { good: Good; buyPrice: number; row: CurrentPrice }[] = [];
  for (const good of goods) {
    const row = priceIndex.get(priceKey(origin.id, good.id));
    if (!row || row.buyPrice === null || row.buyPrice < 0) continue;
    if (row.stock === 0) continue;
    if (!Number.isInteger(good.weight) || good.weight <= 0 || good.weight > capacity) continue;
    if (availableGold !== null && row.buyPrice > availableGold) continue;
    buyable.push({ good, buyPrice: row.buyPrice, row });
  }
  if (buyable.length === 0) return [];

  const suggestions: DestinationSuggestion[] = [];

  for (const port of input.ports) {
    if (excluded.has(port.id)) continue;
    const state = input.portStates.get(port.id) ?? null;
    if (state && !state.hasMarket) continue;
    if (!canUsePort(ship.rate, state?.minShipRate ?? null)) continue;

    const taxBp = taxToBasisPoints(state?.taxPercent ?? null);
    let profitableGoods = 0;
    let allDemo = true;
    let observedAt: string | null = null;

    for (const { good, buyPrice, row } of buyable) {
      const sellRow = priceIndex.get(priceKey(port.id, good.id));
      if (!sellRow || sellRow.sellPrice === null || sellRow.sellPrice < 0) continue;
      if (unitValueScaled(sellRow.sellPrice, buyPrice, taxBp) <= 0) continue;
      profitableGoods += 1;
      if (!row.isDemo || !sellRow.isDemo) allDemo = false;
      for (const seen of [row.observedAt, sellRow.observedAt]) {
        if (observedAt === null || seen > observedAt) observedAt = seen;
      }
    }

    if (profitableGoods === 0) continue;
    suggestions.push({
      port,
      distanceUnits: portDistance(origin, port),
      profitableGoods,
      usesDemoPrices: allDemo,
      observedAt,
    });
  }

  // Nearest first. Ties broken by the wider choice of goods, then by name so
  // the order never wobbles between renders on equal data.
  suggestions.sort(
    (a, b) =>
      a.distanceUnits - b.distanceUnits ||
      b.profitableGoods - a.profitableGoods ||
      a.port.name.localeCompare(b.port.name),
  );
  return suggestions.slice(0, limit);
}
