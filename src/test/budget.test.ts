import { describe, expect, test } from 'vitest';
import { planRoute, type RouteSuccess } from '../domain/calculator';
import { makeGood, makePort, makePortState, makePrice, makeShip, SERVER } from './fixtures';

/**
 * The optional "available gold" limit (SPEC.md 5.7).
 *
 * Early game this matters more than it sounds: capital, not hold space, is
 * usually what stops a player. Two constraints at once (weight and gold) put
 * an exact table out of reach at real scale, so the solver leans on two
 * relaxations that ARE exactly solvable and only falls back to a search when
 * neither proves anything.
 *
 * Two properties have to hold absolutely, and are checked by brute force here:
 *   1. the plan is never unaffordable
 *   2. `provablyOptimal` is never a lie
 *
 * How often it finds the true optimum is a quality measure, not a guarantee,
 * so it is asserted as a floor rather than a fixed number.
 */

interface Spec {
  weight: number;
  buy: number;
  sell: number;
  stock: number;
}

function plan(spec: Spec[], capacity: number, gold: number | null): RouteSuccess {
  const result = planRoute({
    serverId: SERVER,
    origin: makePort('origin', 0, 0),
    destination: makePort('destination', 3, 4),
    originState: makePortState('origin'),
    // No tax and no fee, so profit is purely the buy/sell difference and the
    // brute-force comparison stays simple.
    destinationState: makePortState('destination', { taxPercent: 0, dockingFee: 0 }),
    ship: makeShip('ship', 7, capacity),
    goods: spec.map((s, i) => makeGood(`g${i}`, s.weight)),
    prices: spec.flatMap((s, i) => [
      makePrice('origin', `g${i}`, { buy: s.buy, stock: s.stock }),
      makePrice('destination', `g${i}`, { sell: s.sell }),
    ]),
    availableGold: gold,
  });
  if (!result.ok) throw new Error(`Unexpected failure: ${result.code}`);
  return result;
}

/** Exact answer by exhaustive search, for small cases only. */
function bruteForce(spec: Spec[], capacity: number, gold: number): number {
  let best = 0;
  const walk = (i: number, weight: number, cost: number, profit: number): void => {
    if (i === spec.length) {
      if (profit > best) best = profit;
      return;
    }
    const item = spec[i]!;
    for (let k = 0; k <= item.stock; k++) {
      const nextWeight = weight + k * item.weight;
      const nextCost = cost + k * item.buy;
      if (nextWeight > capacity || nextCost > gold) break;
      walk(i + 1, nextWeight, nextCost, profit + k * (item.sell - item.buy));
    }
  };
  walk(0, 0, 0, 0);
  return best;
}

describe('the gold limit', () => {
  test('is not applied at all when no limit is given', () => {
    const result = plan([{ weight: 10, buy: 100, sell: 250, stock: 10 }], 100, null);
    expect(result.budget).toBeNull();
    expect(result.plan[0]!.quantity).toBe(10);
  });

  test('reports itself as non-binding when there is gold to spare', () => {
    const result = plan([{ weight: 10, buy: 100, sell: 250, stock: 5 }], 100, 100_000);
    expect(result.budget).toEqual({
      availableGold: 100_000,
      binding: false,
      // Ignoring the limit gives an upper bound, so coming in under it proves
      // this plan is also the best once the limit applies.
      provablyOptimal: true,
      // Proven optimal, so the ceiling is simply what the plan earns.
      upperBoundProfit: result.tripProfit,
    });
  });

  test('caps a single good at what the gold can buy', () => {
    // 350 gold at 100 each buys 3, even though the hold would take 10.
    const result = plan([{ weight: 10, buy: 100, sell: 250, stock: 10 }], 100, 350);
    expect(result.plan[0]!.quantity).toBe(3);
    expect(result.totalPurchaseCost).toBeLessThanOrEqual(350);
  });

  test('a good costing more than the total gold is excluded with a reason', () => {
    const result = plan([{ weight: 1, buy: 5_000, sell: 9_000, stock: 3 }], 100, 400);
    expect(result.plan).toHaveLength(0);
    expect(result.excluded[0]!.reason).toBe('unaffordable');
  });
});

describe('against brute force, on many random cases', () => {
  // A fixed seed, so a failure is reproducible rather than a flake.
  let seed = 987_654_321;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };

  const cases: { spec: Spec[]; capacity: number; gold: number }[] = [];
  for (let i = 0; i < 300; i++) {
    const spec: Spec[] = [];
    for (let g = 0; g < 4 + rand(2); g++) {
      const buy = 5 + rand(200);
      spec.push({
        weight: 1 + rand(12),
        buy,
        sell: buy + 1 + rand(120),
        stock: 1 + rand(10),
      });
    }
    cases.push({ spec, capacity: 8 + rand(70), gold: 20 + rand(600) });
  }

  const outcomes = cases.map(({ spec, capacity, gold }) => {
    const result = plan(spec, capacity, gold);
    return { result, best: bruteForce(spec, capacity, gold), gold };
  });

  const binding = outcomes.filter((o) => o.result.budget?.binding);

  test('the sweep actually exercises the constrained path', () => {
    expect(binding.length).toBeGreaterThan(50);
  });

  test('never proposes a cargo the player cannot afford', () => {
    for (const { result, gold } of outcomes) {
      expect(result.totalPurchaseCost).toBeLessThanOrEqual(gold);
    }
  });

  test('never proposes a cargo that does not fit the hold', () => {
    for (const { result } of outcomes) {
      expect(result.totalWeightCarried).toBeLessThanOrEqual(result.holdCapacity);
    }
  });

  test('never claims optimality it does not have', () => {
    // This is the one that must never fail. Reporting a plan as optimal when
    // a better one exists is worse than admitting uncertainty.
    for (const { result, best } of outcomes) {
      if (result.budget?.provablyOptimal) {
        expect(result.tripProfit).toBe(best);
      }
    }
  });

  test('never returns more profit than is actually possible', () => {
    for (const { result, best } of outcomes) {
      expect(result.tripProfit).toBeLessThanOrEqual(best);
    }
  });

  test('the upper bound is a real ceiling, never below what is achievable', () => {
    // The bound is what lets the UI say "within X of the best possible" when
    // optimality cannot be proven. A bound below the true optimum would be a
    // lie in the reassuring direction, which is the worst kind.
    for (const { result, best } of outcomes) {
      if (!result.budget) continue;
      expect(result.budget.upperBoundProfit).toBeGreaterThanOrEqual(best);
      expect(result.budget.upperBoundProfit).toBeGreaterThanOrEqual(result.tripProfit);
    }
  });

  test('a proven plan reports a ceiling equal to its own profit', () => {
    for (const { result } of outcomes) {
      if (result.budget?.provablyOptimal) {
        expect(result.budget.upperBoundProfit).toBe(result.tripProfit);
      }
    }
  });

  test('the ceiling is tight enough to be worth showing', () => {
    // A bound so loose it says "somewhere between 100 and 10000" helps nobody.
    const unproven = binding.filter((o) => !o.result.budget?.provablyOptimal);
    if (unproven.length === 0) return;
    const gaps = unproven.map((o) => {
      const bound = o.result.budget!.upperBoundProfit;
      return bound > 0 ? (bound - o.result.tripProfit) / bound : 0;
    });
    const worst = Math.max(...gaps);
    expect(worst).toBeLessThan(0.5);
  });

  test('finds the true optimum in the large majority of binding cases', () => {
    const exact = binding.filter((o) => o.result.tripProfit === o.best).length;
    const rate = exact / binding.length;
    // Measured at ~96%. The floor is deliberately lower so an unlucky reshuffle
    // is not a failure, but a real regression still is.
    expect(rate).toBeGreaterThan(0.9);
  });
});
