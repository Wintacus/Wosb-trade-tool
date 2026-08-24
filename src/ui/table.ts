import type { CargoLine, RouteSuccess } from '../domain/calculator';
import { taxOnGross, taxToBasisPoints } from '../domain/money';
import type { CurrentPrice, Good, PortState, Tenths } from '../domain/types';

/**
 * The supporting table under the recommendation (SPEC 6.4).
 *
 * Its job is to show *why* the plan is what it is, so it lists every good on
 * the route — including the ones that were rejected, with the reason. The
 * calculator's exclusion list explains rejections but carries no prices, so the
 * rows are rebuilt here from the same prices the calculator was given.
 */
export interface RouteRow {
  goodId: string;
  goodName: string;
  weight: number;
  buyPrice: Tenths | null;
  sellPrice: Tenths | null;
  /** Sell minus buy, before tax. Null when either side is unrecorded. */
  unitMargin: Tenths | null;
  /** After destination tax, rounded the same conservative way as the plan. */
  netUnitProfit: Tenths | null;
  stock: number | null;
  /** Units the plan actually buys. Zero for everything it turned down. */
  quantity: number;
  lineProfit: Tenths;
  lineCost: Tenths;
  lineWeight: number;
  /** Oldest of the two observations behind this row: freshness is worst-case. */
  observedAt: string | null;
  usesDemoPrice: boolean;
  /** Why this good is not in the plan, or null when it is. */
  excludedMessage: string | null;
  inPlan: boolean;
}

export type SortKey = 'totalProfit' | 'profitPerWeight' | 'profitPerDistance' | 'roi';

export const SORT_OPTIONS: { key: SortKey; label: string; hint: string }[] = [
  { key: 'totalProfit', label: 'Total profit', hint: 'Most gold from this trip.' },
  { key: 'profitPerWeight', label: 'Per weight', hint: 'Best use of a limited hold.' },
  {
    key: 'profitPerDistance',
    label: 'Per distance',
    hint: 'Best use of the sailing. On a single route this ranks like total profit.',
  },
  { key: 'roi', label: 'ROI', hint: 'Best return on the gold spent. Matters when capital is short.' },
];

function priceKey(portId: string, goodId: string): string {
  return `${portId} ${goodId}`;
}

/** Oldest of two timestamps, because a plan is only as fresh as its worst half. */
/**
 * Why a good is absent from the plan.
 *
 * The calculator's exclusion list only covers goods it ruled out — a good can
 * also be perfectly profitable and simply lose the competition for hold space.
 * Leaving that row unexplained reads as a bug in the recommendation, so the
 * table says which of the two happened.
 */
function notInPlanMessage(
  goodId: string,
  goodName: string,
  netUnitProfit: Tenths | null,
  excludedByGood: ReadonlyMap<string, string>,
): string {
  const excluded = excludedByGood.get(goodId);
  if (excluded) return excluded;
  if (netUnitProfit !== null && netUnitProfit > 0) {
    return `${goodName} turns a profit, but the hold earns more filled with the goods above.`;
  }
  return `${goodName} does not turn a profit on this route.`;
}

function older(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

export function buildRouteRows(
  result: RouteSuccess,
  goods: readonly Good[],
  prices: readonly CurrentPrice[],
  destinationState: PortState | null,
): RouteRow[] {
  const taxBp = taxToBasisPoints(destinationState?.taxPercent ?? null);

  const priceIndex = new Map<string, CurrentPrice>();
  for (const price of prices) {
    if (price.serverId !== result.serverId) continue;
    if (price.portId === result.originPortId || price.portId === result.destinationPortId) {
      priceIndex.set(priceKey(price.portId, price.goodId), price);
    }
  }

  const planByGood = new Map<string, CargoLine>();
  for (const line of result.plan) planByGood.set(line.goodId, line);

  const excludedByGood = new Map<string, string>();
  for (const entry of result.excluded) excludedByGood.set(entry.goodId, entry.message);

  const rows: RouteRow[] = [];
  for (const good of goods) {
    const buyRow = priceIndex.get(priceKey(result.originPortId, good.id)) ?? null;
    const sellRow = priceIndex.get(priceKey(result.destinationPortId, good.id)) ?? null;
    const line = planByGood.get(good.id) ?? null;

    const buyPrice = buyRow?.buyPrice ?? null;
    const sellPrice = sellRow?.sellPrice ?? null;
    const unitMargin = buyPrice !== null && sellPrice !== null ? sellPrice - buyPrice : null;
    const netUnitProfit =
      buyPrice !== null && sellPrice !== null
        ? sellPrice - taxOnGross(sellPrice, taxBp) - buyPrice
        : null;

    rows.push({
      goodId: good.id,
      goodName: good.name,
      weight: good.weight,
      buyPrice,
      sellPrice,
      unitMargin,
      netUnitProfit,
      stock: buyRow?.stock ?? null,
      quantity: line?.quantity ?? 0,
      lineProfit: line?.netProfit ?? 0,
      lineCost: line?.purchaseCost ?? 0,
      lineWeight: line?.totalWeight ?? 0,
      observedAt: older(buyRow?.observedAt ?? null, sellRow?.observedAt ?? null),
      usesDemoPrice: Boolean(buyRow?.isDemo || sellRow?.isDemo),
      excludedMessage: line ? null : notInPlanMessage(good.id, good.name, netUnitProfit, excludedByGood),
      inPlan: line !== null,
    });
  }
  return rows;
}

/**
 * Rank a row under one of the four metrics (SPEC 5.6).
 *
 * Rows the plan turned down are ranked on what one unit *would* earn, so the
 * table stays a comparison rather than a list of zeros followed by noise. Rows
 * with no price at all sort last whatever the metric.
 */
function rankOf(row: RouteRow, key: SortKey, distanceUnits: number): number | null {
  if (row.inPlan) {
    switch (key) {
      case 'totalProfit':
        return row.lineProfit;
      case 'profitPerWeight':
        return row.lineWeight > 0 ? row.lineProfit / row.lineWeight : null;
      case 'profitPerDistance':
        return distanceUnits > 0 ? row.lineProfit / distanceUnits : null;
      case 'roi':
        return row.lineCost > 0 ? row.lineProfit / row.lineCost : null;
    }
  }
  if (row.netUnitProfit === null) return null;
  switch (key) {
    case 'totalProfit':
      return row.netUnitProfit;
    case 'profitPerWeight':
      return row.weight > 0 ? row.netUnitProfit / row.weight : null;
    case 'profitPerDistance':
      return distanceUnits > 0 ? row.netUnitProfit / distanceUnits : null;
    case 'roi':
      return row.buyPrice && row.buyPrice > 0 ? row.netUnitProfit / row.buyPrice : null;
  }
}

/**
 * Sort the supporting table. Goods in the plan always come first: they are the
 * recommendation, and burying one below a good that was rejected would
 * contradict the screen above it.
 */
export function sortRouteRows(
  rows: readonly RouteRow[],
  key: SortKey,
  distanceUnits: number,
): RouteRow[] {
  return [...rows].sort((a, b) => {
    if (a.inPlan !== b.inPlan) return a.inPlan ? -1 : 1;
    const rankA = rankOf(a, key, distanceUnits);
    const rankB = rankOf(b, key, distanceUnits);
    if (rankA === null && rankB === null) return a.goodName.localeCompare(b.goodName);
    if (rankA === null) return 1;
    if (rankB === null) return -1;
    return rankB - rankA || a.goodName.localeCompare(b.goodName);
  });
}
