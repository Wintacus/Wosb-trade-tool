import { portDistance, canUsePort } from './geo';
import { solveBoundedKnapsack, type KnapsackItem } from './knapsack';
import { taxOnGross, taxToBasisPoints, unitValueScaled } from './money';
import { effectiveShipStats, usableHold, type EffectiveShipStats } from './ships';
import type { CurrentPrice, Good, Port, PortState, Ship, Tenths, Upgrade } from './types';

export type RouteFailureCode =
  | 'same_port'
  | 'origin_has_no_market'
  | 'destination_has_no_market'
  | 'ship_cannot_use_origin'
  | 'ship_cannot_use_destination'
  | 'no_usable_hold';

export interface RouteFailure {
  ok: false;
  code: RouteFailureCode;
  message: string;
  shipRate?: number;
  minShipRate?: number | null;
}

export type ExclusionReason =
  | 'no_price_data'
  | 'no_buy_price_at_origin'
  | 'no_sell_price_at_destination'
  | 'out_of_stock'
  | 'too_heavy_for_hold'
  | 'unaffordable'
  | 'not_profitable';

export interface ExcludedGood {
  goodId: string;
  goodName: string;
  reason: ExclusionReason;
  message: string;
}

export interface CargoLine {
  goodId: string;
  goodName: string;
  weight: number;
  quantity: number;
  buyPrice: Tenths;
  sellPrice: Tenths;
  /** sell minus buy, before tax. Shown so the user can see why a good was chosen. */
  unitMargin: Tenths;
  grossRevenue: Tenths;
  taxAmount: Tenths;
  purchaseCost: Tenths;
  netProfit: Tenths;
  totalWeight: number;
  /** null stock means "quantity not shown in game", not "none available". */
  stock: number | null;
  stockWasUnknown: boolean;
  usesDemoPrice: boolean;
  oldestObservationAt: string;
}

export interface RouteMetrics {
  /** Trip profit in tenths of gold. */
  totalProfit: Tenths;
  /** Ratios, for sorting and display only, never treated as currency. */
  profitPerWeight: number | null;
  profitPerDistance: number | null;
  roi: number | null;
}

export interface UnverifiedFlags {
  /** Destination tax is unknown. Treated as 0, and must be said out loud. */
  taxUnknown: boolean;
  /** Docking fee has never been observed in game. Treated as 0. */
  dockingFeeUnverified: boolean;
  /** Any price used came from seeded demo data rather than a real submission. */
  usesDemoPrices: boolean;
  /** The ship record itself is flagged unverified. */
  shipUnverified: boolean;
}

export interface BudgetReport {
  availableGold: Tenths;
  /** True when the gold limit actually changed the plan. */
  binding: boolean;
  /**
   * False means the plan is affordable and good but not proven to be the best
   * possible under the gold limit. Never reported as optimal when unproven.
   */
  provablyOptimal: boolean;
}

export interface RouteSuccess {
  ok: true;
  serverId: string;
  originPortId: string;
  destinationPortId: string;
  shipId: string;
  stats: EffectiveShipStats;
  holdCapacity: number;
  /** Abstract map units. Never minutes, because travel time cannot be predicted. */
  distanceUnits: number;
  plan: CargoLine[];
  totalWeightCarried: number;
  totalPurchaseCost: Tenths;
  totalGrossRevenue: Tenths;
  totalTax: Tenths;
  dockingFee: Tenths;
  tripProfit: Tenths;
  metrics: RouteMetrics;
  unverified: UnverifiedFlags;
  excluded: ExcludedGood[];
  budget: BudgetReport | null;
  /** Set when the plan is empty, explaining why in plain language. */
  emptyReason: string | null;
  notes: string[];
}

export type RouteResult = RouteSuccess | RouteFailure;

export interface RouteInput {
  serverId: string;
  origin: Port;
  destination: Port;
  originState: PortState | null;
  destinationState: PortState | null;
  ship: Ship;
  upgrades?: readonly Upgrade[];
  goods: readonly Good[];
  /** Rows from the prices_current view covering both ports. */
  prices: readonly CurrentPrice[];
  /** Optional spending limit in tenths of gold (SPEC.md 5.7). */
  availableGold?: Tenths | null;
}

const SPEED_CAVEAT =
  'Base speed. Actual speed varies with wind direction, sails and cargo load.';
const LOAD_CAVEAT =
  'Cargo weight is known to slow a ship, but the formula is unknown, so it is not modelled.';

function priceKey(portId: string, goodId: string): string {
  return `${portId} ${goodId}`;
}

/**
 * Plan the most profitable cargo for a single origin to destination trip.
 *
 * Returns a failure only for structurally impossible routes (same port, a port
 * the ship cannot use, a port with no market). A route that is merely
 * unprofitable is a success with an empty plan and a reason, because an empty
 * result is an answer rather than an error (SPEC.md 5.9 test 8).
 */
export function planRoute(input: RouteInput): RouteResult {
  const { serverId, origin, destination, originState, destinationState, ship, goods } = input;

  // Guard the degenerate route before anything divides by distance (test 5).
  if (origin.id === destination.id) {
    return {
      ok: false,
      code: 'same_port',
      message: 'Origin and destination are the same port. Pick two different ports.',
    };
  }

  // Rate gating applies to leaving as well as arriving (4.1, test 4).
  if (!canUsePort(ship.rate, originState?.minShipRate ?? null)) {
    return {
      ok: false,
      code: 'ship_cannot_use_origin',
      message:
        `${ship.name} is rate ${ship.rate}. ${origin.displayName ?? origin.name} admits only ` +
        `rate ${originState?.minShipRate} and higher-numbered ships, so it cannot undock there.`,
      shipRate: ship.rate,
      minShipRate: originState?.minShipRate ?? null,
    };
  }
  if (!canUsePort(ship.rate, destinationState?.minShipRate ?? null)) {
    return {
      ok: false,
      code: 'ship_cannot_use_destination',
      message:
        `${ship.name} is rate ${ship.rate}. ${destination.displayName ?? destination.name} admits only ` +
        `rate ${destinationState?.minShipRate} and higher-numbered ships, so it cannot dock there.`,
      shipRate: ship.rate,
      minShipRate: destinationState?.minShipRate ?? null,
    };
  }

  if (originState && !originState.hasMarket) {
    return {
      ok: false,
      code: 'origin_has_no_market',
      message: `${origin.displayName ?? origin.name} has no market, so nothing can be bought there.`,
    };
  }
  if (destinationState && !destinationState.hasMarket) {
    return {
      ok: false,
      code: 'destination_has_no_market',
      message: `${destination.displayName ?? destination.name} has no market, so nothing can be sold there.`,
    };
  }

  const stats = effectiveShipStats(ship, input.upgrades ?? []);
  const capacity = usableHold(stats);
  if (capacity <= 0) {
    return {
      ok: false,
      code: 'no_usable_hold',
      message: `${ship.name} has no usable hold capacity, so it cannot carry cargo.`,
    };
  }

  const distanceUnits = portDistance(origin, destination);

  // null tax means UNKNOWN. It becomes 0 for arithmetic and is flagged loudly.
  // It is never replaced with a plausible-looking default (5.3).
  const taxUnknown = destinationState?.taxPercent == null;
  const taxBp = taxToBasisPoints(destinationState?.taxPercent ?? null);
  const dockingFeeUnverified = destinationState?.dockingFee == null;
  const dockingFee = destinationState?.dockingFee ?? 0;

  const availableGold = input.availableGold ?? null;
  const hasBudget =
    availableGold !== null && Number.isFinite(availableGold) && availableGold >= 0;

  const priceIndex = new Map<string, CurrentPrice>();
  for (const p of input.prices) {
    if (p.serverId !== serverId) continue;
    if (p.portId === origin.id || p.portId === destination.id) {
      priceIndex.set(priceKey(p.portId, p.goodId), p);
    }
  }

  const excluded: ExcludedGood[] = [];
  const candidates: KnapsackItem[] = [];
  const byId: CandidateIndex = new Map();

  for (const good of goods) {
    const buyRow = priceIndex.get(priceKey(origin.id, good.id));
    const sellRow = priceIndex.get(priceKey(destination.id, good.id));

    if (!buyRow && !sellRow) {
      excluded.push({
        goodId: good.id,
        goodName: good.name,
        reason: 'no_price_data',
        message: `No price recorded for ${good.name} at either port.`,
      });
      continue;
    }
    if (!buyRow || buyRow.buyPrice === null) {
      excluded.push({
        goodId: good.id,
        goodName: good.name,
        reason: 'no_buy_price_at_origin',
        message: `No buy price recorded for ${good.name} at ${origin.displayName ?? origin.name}.`,
      });
      continue;
    }
    if (!sellRow || sellRow.sellPrice === null) {
      excluded.push({
        goodId: good.id,
        goodName: good.name,
        reason: 'no_sell_price_at_destination',
        message: `No sell price recorded for ${good.name} at ${destination.displayName ?? destination.name}.`,
      });
      continue;
    }
    if (good.weight <= 0 || !Number.isInteger(good.weight)) {
      excluded.push({
        goodId: good.id,
        goodName: good.name,
        reason: 'no_price_data',
        message: `${good.name} has no usable weight recorded, so it cannot be planned.`,
      });
      continue;
    }
    if (good.weight > capacity) {
      excluded.push({
        goodId: good.id,
        goodName: good.name,
        reason: 'too_heavy_for_hold',
        message: `One unit of ${good.name} weighs ${good.weight}, more than the ${capacity} hold.`,
      });
      continue;
    }
    if (buyRow.stock === 0) {
      excluded.push({
        goodId: good.id,
        goodName: good.name,
        reason: 'out_of_stock',
        message: `${good.name} is recorded as out of stock at ${origin.displayName ?? origin.name}.`,
      });
      continue;
    }
    if (hasBudget && buyRow.buyPrice > availableGold) {
      excluded.push({
        goodId: good.id,
        goodName: good.name,
        reason: 'unaffordable',
        message: `A single unit of ${good.name} costs more than the gold available.`,
      });
      continue;
    }

    const scaled = unitValueScaled(sellRow.sellPrice, buyRow.buyPrice, taxBp);
    if (scaled <= 0) {
      excluded.push({
        goodId: good.id,
        goodName: good.name,
        reason: 'not_profitable',
        message: `${good.name} does not make a profit on this route after tax.`,
      });
      continue;
    }

    // Null stock is COMMON: the Market screen shows no quantity for trade goods.
    // It means unknown, so the bound is the hold, never zero (5.5, test 9).
    const byCapacity = Math.floor(capacity / good.weight);
    const byStock = buyRow.stock === null ? byCapacity : buyRow.stock;
    const byGold = hasBudget ? Math.floor(availableGold / buyRow.buyPrice) : byCapacity;
    const maxQuantity = Math.max(0, Math.min(byCapacity, byStock, byGold));
    if (maxQuantity <= 0) continue;

    candidates.push({ id: good.id, weight: good.weight, value: scaled, maxQuantity });
    byId.set(good.id, { good, buy: buyRow, sell: sellRow });
  }

  let picks = solveBoundedKnapsack(candidates, capacity).picks;
  let budget: BudgetReport | null = null;

  if (hasBudget) {
    const cost = totalCostOf(picks, byId);
    if (cost <= availableGold) {
      // The solved problem ignores the overall gold limit, so its optimum is an
      // upper bound on the limited problem. Coming in under the limit therefore
      // proves this plan is also optimal once the limit is applied.
      budget = { availableGold, binding: false, provablyOptimal: true };
    } else {
      const constrained = solveWithinBudget(candidates, byId, capacity, availableGold);
      picks = constrained.picks;
      budget = {
        availableGold,
        binding: true,
        provablyOptimal: constrained.provablyOptimal,
      };
    }
  }

  const plan: CargoLine[] = [];
  let totalWeightCarried = 0;
  let totalPurchaseCost = 0;
  let totalGrossRevenue = 0;
  let totalTax = 0;
  let netTotal = 0;
  let usesDemoPrices = false;

  for (const pick of picks) {
    const entry = byId.get(pick.id);
    if (!entry || pick.quantity <= 0) continue;
    const { good, buy, sell } = entry;
    const buyPrice = buy.buyPrice as number;
    const sellPrice = sell.sellPrice as number;

    const grossRevenue = sellPrice * pick.quantity;
    const taxAmount = taxOnGross(grossRevenue, taxBp);
    const purchaseCost = buyPrice * pick.quantity;
    const netProfit = grossRevenue - taxAmount - purchaseCost;
    const lineWeight = good.weight * pick.quantity;

    if (buy.isDemo || sell.isDemo) usesDemoPrices = true;

    plan.push({
      goodId: good.id,
      goodName: good.name,
      weight: good.weight,
      quantity: pick.quantity,
      buyPrice,
      sellPrice,
      unitMargin: sellPrice - buyPrice,
      grossRevenue,
      taxAmount,
      purchaseCost,
      netProfit,
      totalWeight: lineWeight,
      stock: buy.stock,
      stockWasUnknown: buy.stock === null,
      usesDemoPrice: buy.isDemo || sell.isDemo,
      oldestObservationAt:
        buy.observedAt < sell.observedAt ? buy.observedAt : sell.observedAt,
    });

    totalWeightCarried += lineWeight;
    totalPurchaseCost += purchaseCost;
    totalGrossRevenue += grossRevenue;
    totalTax += taxAmount;
    netTotal += netProfit;
  }

  plan.sort((a, b) => b.netProfit - a.netProfit);

  // The docking fee is charged once per trip, not per unit (5.3).
  const tripProfit = netTotal - dockingFee;

  const notes: string[] = [SPEED_CAVEAT, LOAD_CAVEAT];
  if (taxUnknown) {
    notes.push(
      `Tax at ${destination.displayName ?? destination.name} is unknown and was treated as 0%. ` +
        'Real observed rates range from 4% to 12%, so true profit is lower than shown.',
    );
  }
  if (dockingFeeUnverified) {
    notes.push(
      'Docking fee is unverified, having never been observed in game, and was treated as 0.',
    );
  }
  if (usesDemoPrices) {
    notes.push('Some prices used here are seeded demo data, not real observations.');
  }

  let emptyReason: string | null = null;
  if (plan.length === 0) {
    const originName = origin.displayName ?? origin.name;
    const destinationName = destination.displayName ?? destination.name;
    if (candidates.length > 0) {
      emptyReason = 'No cargo fits the hold and gold available on this route.';
    } else if (excluded.some((e) => e.reason === 'not_profitable')) {
      emptyReason =
        `Nothing can be carried profitably from ${originName} to ${destinationName} at the ` +
        'prices recorded. That is a real answer, not a failure: these two ports are priced ' +
        'too similarly to make a margin.';
    } else {
      emptyReason =
        `There is not enough price data for ${originName} and ${destinationName} to plan a ` +
        'cargo yet. Add prices for both ports and try again.';
    }
  }

  return {
    ok: true,
    serverId,
    originPortId: origin.id,
    destinationPortId: destination.id,
    shipId: ship.id,
    stats,
    holdCapacity: capacity,
    distanceUnits,
    plan,
    totalWeightCarried,
    totalPurchaseCost,
    totalGrossRevenue,
    totalTax,
    dockingFee,
    tripProfit,
    metrics: {
      totalProfit: tripProfit,
      profitPerWeight: totalWeightCarried > 0 ? tripProfit / totalWeightCarried : null,
      profitPerDistance: distanceUnits > 0 ? tripProfit / distanceUnits : null,
      roi: totalPurchaseCost > 0 ? tripProfit / totalPurchaseCost : null,
    },
    unverified: {
      taxUnknown,
      dockingFeeUnverified,
      usesDemoPrices,
      shipUnverified: stats.unverifiedShip,
    },
    excluded,
    budget,
    emptyReason,
    notes,
  };
}

type CandidateIndex = Map<string, { good: Good; buy: CurrentPrice; sell: CurrentPrice }>;

function totalCostOf(
  picks: readonly { id: string; quantity: number }[],
  index: CandidateIndex,
): Tenths {
  let cost = 0;
  for (const pick of picks) {
    const entry = index.get(pick.id);
    if (entry) cost += (entry.buy.buyPrice as number) * pick.quantity;
  }
  return cost;
}

/**
 * Cargo plan for when the gold limit actually bites.
 *
 * Two constraints at once, hold weight and gold, make an exact table
 * impractical at this scale: the grid would run to billions of cells. Instead
 * the gold limit is priced into the objective and that price is raised until
 * the plan becomes affordable, which is the standard Lagrangian approach.
 *
 * The result is always affordable. It is reported as provably optimal only when
 * it spends the budget exactly; otherwise provablyOptimal is false and the
 * caller is expected to say so rather than imply certainty.
 */
function solveWithinBudget(
  candidates: readonly KnapsackItem[],
  index: CandidateIndex,
  capacity: number,
  availableGold: Tenths,
): { picks: { id: string; quantity: number }[]; provablyOptimal: boolean } {
  const DENOMINATOR = 1024;

  // Search in whole tenths so the penalised objective stays well inside exact
  // integer range. Final money is always recomputed from the chosen
  // quantities, never read back out of these search values.
  const priced = candidates.map((item) => {
    const entry = index.get(item.id)!;
    return {
      item,
      profitTenths: Math.round(item.value / 10_000),
      unitCost: entry.buy.buyPrice as number,
    };
  });

  const solveAt = (penaltyNumerator: number) => {
    const adjusted: KnapsackItem[] = [];
    for (const p of priced) {
      const value = p.profitTenths * DENOMINATOR - penaltyNumerator * p.unitCost;
      if (value > 0) adjusted.push({ ...p.item, value });
    }
    const picks = solveBoundedKnapsack(adjusted, capacity).picks;
    return { picks, cost: totalCostOf(picks, index) };
  };

  let maxRatio = 0;
  for (const p of priced) {
    if (p.unitCost > 0) maxRatio = Math.max(maxRatio, p.profitTenths / p.unitCost);
  }

  let low = 0; // known to overspend
  let high = Math.ceil((maxRatio + 1) * DENOMINATOR); // prices every good out
  let best = solveAt(high);

  // Invariant: `high` always yields an affordable plan. Narrow it towards `low`.
  for (let i = 0; i < 40 && low + 1 < high; i++) {
    const mid = Math.floor((low + high) / 2);
    const attempt = solveAt(mid);
    if (attempt.cost <= availableGold) {
      high = mid;
      best = attempt;
    } else {
      low = mid;
    }
  }

  return {
    picks: best.picks,
    // Spending the budget exactly means no gold sat idle, which is the only
    // cheap optimality certificate available here. Anything else stays unproven.
    provablyOptimal: best.cost === availableGold,
  };
}

export interface TripPlan {
  outbound: RouteResult;
  /** The common out-and-back pattern. Not full multi-leg routing (5.8). */
  returnLeg: RouteResult;
}

/** Plan the outbound trip and the return leg using the same recorded prices. */
export function planTrip(input: RouteInput): TripPlan {
  return {
    outbound: planRoute(input),
    returnLeg: planRoute({
      ...input,
      origin: input.destination,
      destination: input.origin,
      originState: input.destinationState,
      destinationState: input.originState,
    }),
  };
}
