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

/** Largest cost-axis table this is willing to build, to bound memory use. */
const MAX_COST_CELLS = 150_000;

interface BudgetCandidate {
  picks: { id: string; quantity: number }[];
  value: number;
  cost: Tenths;
  weight: number;
}

/**
 * Cargo plan for when the gold limit actually bites.
 *
 * Two constraints at once, hold weight and gold, put an exact table out of
 * reach: at a 54,000 hold and a real bankroll the grid runs to billions of
 * cells. What works instead is to solve each constraint exactly on its own and
 * look for a certificate.
 *
 * Relaxing a constraint can only ever help, so a relaxed optimum is an upper
 * bound on the real one. That gives a free proof: if the plan that ignores
 * weight happens to fit the hold anyway, no better plan can exist, and the
 * same in reverse. When neither certificate fires, both constraints genuinely
 * bind and the answer is the best of several feasible candidates, reported
 * honestly as unproven rather than dressed up as optimal.
 */
function solveWithinBudget(
  candidates: readonly KnapsackItem[],
  index: CandidateIndex,
  capacity: number,
  availableGold: Tenths,
): { picks: { id: string; quantity: number }[]; provablyOptimal: boolean } {
  const priced = candidates.map((item) => ({
    item,
    unitCost: index.get(item.id)!.buy.buyPrice as number,
  }));
  const costOf = new Map(priced.map((p) => [p.item.id, p.unitCost]));

  const measure = (picks: { id: string; quantity: number }[]): BudgetCandidate => {
    let value = 0;
    let cost = 0;
    let weight = 0;
    for (const pick of picks) {
      const item = candidates.find((c) => c.id === pick.id)!;
      value += item.value * pick.quantity;
      cost += (costOf.get(pick.id) ?? 0) * pick.quantity;
      weight += item.weight * pick.quantity;
    }
    return { picks, value, cost, weight };
  };

  const feasible: BudgetCandidate[] = [];
  let proven = false;

  // --- Relaxation: ignore the hold, spend gold optimally -------------------
  // Costs are quantised upward when the budget is large, which keeps the table
  // bounded and can only ever make a plan cheaper than it is allowed to be, so
  // the result is always affordable.
  const granularity = Math.max(1, Math.ceil(availableGold / MAX_COST_CELLS));
  const costItems: KnapsackItem[] = [];
  for (const { item, unitCost } of priced) {
    if (unitCost <= 0) continue;
    costItems.push({
      id: item.id,
      weight: Math.ceil(unitCost / granularity),
      value: item.value,
      maxQuantity: item.maxQuantity,
    });
  }
  if (costItems.length > 0) {
    const byCost = measure(
      solveBoundedKnapsack(costItems, Math.floor(availableGold / granularity)).picks,
    );
    if (byCost.cost <= availableGold && byCost.weight <= capacity) {
      feasible.push(byCost);
      // Exact only when nothing was quantised away.
      if (granularity === 1) proven = true;
    }
  }

  // --- Lagrangian search --------------------------------------------------
  // Price the gold limit into the objective and raise that price until the
  // plan becomes affordable.
  if (!proven) {
    const DENOMINATOR = 1024;
    const forSearch = priced.map((p) => ({
      ...p,
      // Search in whole tenths so the penalised objective stays well inside
      // exact-integer range. Money is always recomputed from the quantities.
      profitTenths: Math.round(p.item.value / 10_000),
    }));

    const solveAt = (penalty: number) => {
      const adjusted: KnapsackItem[] = [];
      for (const p of forSearch) {
        const value = p.profitTenths * DENOMINATOR - penalty * p.unitCost;
        if (value > 0) adjusted.push({ ...p.item, value });
      }
      return measure(solveBoundedKnapsack(adjusted, capacity).picks);
    };

    let maxRatio = 0;
    for (const p of forSearch) {
      if (p.unitCost > 0) maxRatio = Math.max(maxRatio, p.profitTenths / p.unitCost);
    }

    let low = 0; // overspends
    let high = Math.ceil((maxRatio + 1) * DENOMINATOR); // prices everything out
    let best = solveAt(high);
    // The richest plan seen that was just out of reach. Trimming it back is
    // often better than the first plan that happened to come in under budget.
    let overspent: BudgetCandidate | null = null;

    for (let i = 0; i < 40 && low + 1 < high; i++) {
      const mid = Math.floor((low + high) / 2);
      const attempt = solveAt(mid);
      if (attempt.cost <= availableGold) {
        high = mid;
        best = attempt;
      } else {
        low = mid;
        overspent = attempt;
      }
    }

    if (best.cost <= availableGold) feasible.push(best);
    if (overspent) {
      const trimmed = stripDown(overspent, candidates, costOf, capacity, availableGold);
      if (trimmed.cost <= availableGold && trimmed.weight <= capacity) feasible.push(trimmed);
    }
  }

  // --- Repair -------------------------------------------------------------
  // A relaxed solve often leaves room in whichever constraint it ignored.
  // Topping the cargo up can only improve a plan, never break it.
  const repaired = feasible.flatMap((candidate) => [
    topUp(candidate, candidates, costOf, capacity, availableGold, 'cost'),
    topUp(candidate, candidates, costOf, capacity, availableGold, 'weight'),
  ]);

  const all = [...feasible, ...repaired].filter(
    (c) => c.cost <= availableGold && c.weight <= capacity,
  );
  if (all.length === 0) return { picks: [], provablyOptimal: false };

  const winner = all.reduce((a, b) => (b.value > a.value ? b : a));
  return { picks: winner.picks, provablyOptimal: proven };
}

/**
 * Cut a plan back until it is affordable and fits, dropping the cargo that
 * earns least per gold spent first.
 *
 * The plan handed in comes from a search that overspent, which means it is
 * richer than anything already within budget. Trimming the worst of it often
 * beats the first plan that happened to come in under the limit.
 */
function stripDown(
  candidate: BudgetCandidate,
  items: readonly KnapsackItem[],
  costOf: ReadonlyMap<string, number>,
  capacity: number,
  availableGold: Tenths,
): BudgetCandidate {
  const quantities = new Map(candidate.picks.map((p) => [p.id, p.quantity]));
  let cost = candidate.cost;
  let weight = candidate.weight;

  // Worst value for money first.
  const order = [...items].sort(
    (a, b) => a.value / (costOf.get(a.id) || 1) - b.value / (costOf.get(b.id) || 1),
  );

  for (const item of order) {
    if (cost <= availableGold && weight <= capacity) break;
    const held = quantities.get(item.id) ?? 0;
    if (held <= 0) continue;

    const unitCost = costOf.get(item.id) ?? 0;
    const dropForGold = unitCost > 0 ? Math.ceil((cost - availableGold) / unitCost) : 0;
    const dropForSpace = Math.ceil((weight - capacity) / item.weight);
    const drop = Math.min(held, Math.max(dropForGold, dropForSpace, 0));
    if (drop <= 0) continue;

    quantities.set(item.id, held - drop);
    cost -= drop * unitCost;
    weight -= drop * item.weight;
  }

  return rebuild(quantities, items, costOf);
}

/**
 * Add whatever else still fits in both the hold and the remaining gold.
 *
 * `by` chooses which resource to be greedy about: profit per unit of gold when
 * gold is the tight one, profit per unit of weight when the hold is.
 */
function topUp(
  candidate: BudgetCandidate,
  items: readonly KnapsackItem[],
  costOf: ReadonlyMap<string, number>,
  capacity: number,
  availableGold: Tenths,
  by: 'cost' | 'weight',
): BudgetCandidate {
  const quantities = new Map(candidate.picks.map((p) => [p.id, p.quantity]));
  let remainingWeight = capacity - candidate.weight;
  let remainingGold = availableGold - candidate.cost;

  const order = [...items].sort((a, b) => {
    const aCost = costOf.get(a.id) ?? 1;
    const bCost = costOf.get(b.id) ?? 1;
    const aRatio = by === 'cost' ? a.value / aCost : a.value / a.weight;
    const bRatio = by === 'cost' ? b.value / bCost : b.value / b.weight;
    return bRatio - aRatio;
  });

  for (const item of order) {
    const unitCost = costOf.get(item.id) ?? 0;
    const already = quantities.get(item.id) ?? 0;
    const room = item.maxQuantity - already;
    if (room <= 0) continue;

    const extra = Math.min(
      room,
      Math.floor(remainingWeight / item.weight),
      unitCost > 0 ? Math.floor(remainingGold / unitCost) : room,
    );
    if (extra <= 0) continue;

    quantities.set(item.id, already + extra);
    remainingWeight -= extra * item.weight;
    remainingGold -= extra * unitCost;
  }

  return rebuild(quantities, items, costOf);
}

/** Turn a quantity map back into a candidate with its totals recomputed. */
function rebuild(
  quantities: ReadonlyMap<string, number>,
  items: readonly KnapsackItem[],
  costOf: ReadonlyMap<string, number>,
): BudgetCandidate {
  let value = 0;
  let cost = 0;
  let weight = 0;
  const picks: { id: string; quantity: number }[] = [];

  for (const [id, quantity] of quantities) {
    if (quantity <= 0) continue;
    const item = items.find((i) => i.id === id);
    if (!item) continue;
    picks.push({ id, quantity });
    value += item.value * quantity;
    cost += (costOf.get(id) ?? 0) * quantity;
    weight += item.weight * quantity;
  }

  return { picks, value, cost, weight };
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
