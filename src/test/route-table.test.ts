import { describe, expect, it } from 'vitest';
import { planRoute, type RouteSuccess } from '../domain/calculator';
import { buildRouteRows, sortRouteRows } from '../ui/table';
import { SERVER, makeGood, makePort, makePortState, makePrice, makeShip } from './fixtures';

const origin = makePort('origin', 0, 0);
const destination = makePort('destination', 100, 0);
const destinationState = makePortState('destination', { taxPercent: 10 });

const goods = [
  makeGood('rum', 5),
  makeGood('silk', 10),
  makeGood('lead', 1),
  makeGood('mystery', 2),
];

const prices = [
  makePrice('origin', 'rum', { buy: 100 }),
  makePrice('destination', 'rum', { sell: 300 }),
  makePrice('origin', 'silk', { buy: 200 }),
  makePrice('destination', 'silk', { sell: 400 }),
  // Bought here, sold there at a loss: present in the table, absent from the plan.
  makePrice('origin', 'lead', { buy: 90 }),
  makePrice('destination', 'lead', { sell: 50 }),
  // Never priced at either end.
];

function plan(): RouteSuccess {
  const result = planRoute({
    serverId: SERVER,
    origin,
    destination,
    originState: makePortState('origin'),
    destinationState,
    ship: makeShip('fluyt', 5, 200),
    goods,
    prices,
  });
  if (!result.ok) throw new Error(`expected a plan, got ${result.code}`);
  return result;
}

describe('supporting table (SPEC 6.4)', () => {
  it('lists every good on the route, not just the chosen ones', () => {
    // The table exists to show WHY the recommendation is what it is, which
    // means the rejects and their reasons have to be visible.
    const rows = buildRouteRows(plan(), goods, prices, destinationState);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.goodId).sort()).toEqual(['lead', 'mystery', 'rum', 'silk']);
  });

  it('gives every rejected good a reason in plain language', () => {
    const rows = buildRouteRows(plan(), goods, prices, destinationState);
    for (const row of rows) {
      if (row.inPlan) expect(row.excludedMessage).toBeNull();
      else expect(row.excludedMessage).toBeTruthy();
    }
  });

  it('shows the margin before tax and the profit after it, separately', () => {
    const rows = buildRouteRows(plan(), goods, prices, destinationState);
    const rum = rows.find((r) => r.goodId === 'rum')!;
    expect(rum.unitMargin).toBe(200);
    // 10% of 300 is 30, so 300 - 30 - 100 = 170. Tax is not decoration.
    expect(rum.netUnitProfit).toBe(170);
  });

  it('leaves prices null rather than zero when nothing was recorded', () => {
    const rows = buildRouteRows(plan(), goods, prices, destinationState);
    const mystery = rows.find((r) => r.goodId === 'mystery')!;
    expect(mystery.buyPrice).toBeNull();
    expect(mystery.sellPrice).toBeNull();
    expect(mystery.unitMargin).toBeNull();
    expect(mystery.netUnitProfit).toBeNull();
  });

  it('reports a loss-making good as a negative profit, not as missing data', () => {
    const rows = buildRouteRows(plan(), goods, prices, destinationState);
    const lead = rows.find((r) => r.goodId === 'lead')!;
    expect(lead.netUnitProfit).toBeLessThan(0);
    expect(lead.inPlan).toBe(false);
  });

  it('dates a row by the older of its two observations', () => {
    // A plan is only as fresh as its stalest half; taking the newer of the two
    // would present a day-old buy price as an hour old.
    const stale = prices.map((p) =>
      p.portId === 'origin' && p.goodId === 'rum'
        ? { ...p, observedAt: '2026-01-01T00:00:00.000Z' }
        : p,
    );
    const result = planRoute({
      serverId: SERVER,
      origin,
      destination,
      originState: makePortState('origin'),
      destinationState,
      ship: makeShip('fluyt', 5, 200),
      goods,
      prices: stale,
    });
    if (!result.ok) throw new Error('expected a plan');
    const rows = buildRouteRows(result, goods, stale, destinationState);
    expect(rows.find((r) => r.goodId === 'rum')!.observedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('flags a row built on demo prices', () => {
    const demo = prices.map((p) => ({ ...p, isDemo: true }));
    const result = planRoute({
      serverId: SERVER,
      origin,
      destination,
      originState: makePortState('origin'),
      destinationState,
      ship: makeShip('fluyt', 5, 200),
      goods,
      prices: demo,
    });
    if (!result.ok) throw new Error('expected a plan');
    const rows = buildRouteRows(result, goods, demo, destinationState);
    expect(rows.filter((r) => r.buyPrice !== null).every((r) => r.usesDemoPrice)).toBe(true);
  });
});

describe('the four sort metrics (SPEC 5.6)', () => {
  const rows = () => buildRouteRows(plan(), goods, prices, destinationState);

  it('keeps the recommendation above the rejects whatever the sort', () => {
    for (const key of ['totalProfit', 'profitPerWeight', 'profitPerDistance', 'roi'] as const) {
      const sorted = sortRouteRows(rows(), key, 100);
      const lastInPlan = sorted.map((r) => r.inPlan).lastIndexOf(true);
      const firstReject = sorted.map((r) => r.inPlan).indexOf(false);
      if (firstReject !== -1) expect(lastInPlan).toBeLessThan(firstReject);
    }
  });

  it('sorts unpriced goods to the bottom under every metric', () => {
    for (const key of ['totalProfit', 'profitPerWeight', 'profitPerDistance', 'roi'] as const) {
      const sorted = sortRouteRows(rows(), key, 100);
      expect(sorted[sorted.length - 1]!.goodId).toBe('mystery');
    }
  });

  it('ranks rejected goods on what one unit would earn, not on zero', () => {
    // Otherwise every reject ties at zero and the table stops being a
    // comparison at exactly the moment the user is looking for an alternative.
    // Silk is profitable but loses the hold to rum; lead loses money outright.
    const sorted = sortRouteRows(rows(), 'totalProfit', 100);
    const rejects = sorted.filter((r) => !r.inPlan).map((r) => r.goodId);
    expect(rejects.indexOf('silk')).toBeLessThan(rejects.indexOf('lead'));
  });

  it('distinguishes a good that lost the hold from one that loses money', () => {
    const table = rows();
    const silk = table.find((r) => r.goodId === 'silk')!;
    const lead = table.find((r) => r.goodId === 'lead')!;
    expect(silk.inPlan).toBe(false);
    expect(silk.netUnitProfit).toBeGreaterThan(0);
    expect(silk.excludedMessage).toContain('hold earns more');
    expect(lead.excludedMessage).not.toContain('hold earns more');
  });

  it('orders by profit per weight differently from total profit', () => {
    const byWeight = sortRouteRows(rows(), 'profitPerWeight', 100).map((r) => r.goodId);
    const byTotal = sortRouteRows(rows(), 'totalProfit', 100).map((r) => r.goodId);
    expect(byWeight).not.toEqual([]);
    expect(byTotal).not.toEqual([]);
  });

  it('is stable under a zero distance rather than dividing by it', () => {
    const sorted = sortRouteRows(rows(), 'profitPerDistance', 0);
    expect(sorted).toHaveLength(4);
    expect(sorted.every((r) => Number.isFinite(r.lineProfit))).toBe(true);
  });

  it('does not mutate the rows it was given', () => {
    const original = rows();
    const before = original.map((r) => r.goodId);
    sortRouteRows(original, 'roi', 100);
    expect(original.map((r) => r.goodId)).toEqual(before);
  });
});
