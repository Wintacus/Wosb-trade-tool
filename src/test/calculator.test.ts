import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planRoute, planTrip, type RouteSuccess } from '../domain/calculator';
import { solveBoundedKnapsack } from '../domain/knapsack';
import { toTenths } from '../domain/money';
import { makeGood, makePort, makePortState, makePrice, makeShip, SERVER } from './fixtures';
import { repoRoot } from './pg';

/**
 * The eleven required calculator tests from SPEC.md 5.9.
 *
 * Test 10 (demo-data displacement) lives in prices-current.test.ts because it
 * exercises the SQL view rather than the TypeScript calculator.
 */

function expectOk(result: ReturnType<typeof planRoute>): RouteSuccess {
  if (!result.ok) throw new Error(`Expected a plan, got failure: ${result.code} ${result.message}`);
  return result;
}

// ---------------------------------------------------------------------------
// 1. Known-answer test
// ---------------------------------------------------------------------------
describe('1. known-answer test', () => {
  // Every number below is computed by hand in the comments, then asserted
  // exactly. Nothing here is copied back out of the implementation.
  //
  // Ship hold 100. Destination tax 10%. Docking fee 5.0 gold (50 tenths).
  // Ports 300 east and 400 south of each other, so distance is exactly 500.
  //
  //   alpha  weight 10, buy 10.0, sell 15.0, stock 6
  //   beta   weight 25, buy 20.0, sell 26.0, stock unknown
  //
  // Per unit, after 10% tax on the sale:
  //   alpha  15.0 * 0.9 - 10.0 = 3.5 gold per unit, per weight 0.35
  //   beta   26.0 * 0.9 - 20.0 = 3.4 gold per unit, per weight 0.136
  //
  // Best cargo within 100 weight, alpha capped at 6 units:
  //   alpha 6 (60 wt) + beta 1 (25 wt) = 85 wt  -> 21.0 + 3.4 = 24.4 gold
  //   alpha 5 (50 wt) + beta 2 (50 wt) = 100 wt -> 17.5 + 6.8 = 24.3 gold
  //   so alpha 6 + beta 1 wins by 0.1 gold.
  //
  // Reported, in tenths:
  //   alpha gross 900, tax ceil(90.0) = 90, cost 600, net 210
  //   beta  gross 260, tax ceil(26.0) = 26, cost 200, net  34
  //   sum 244, minus docking fee 50 -> trip profit 194 tenths = 19.4 gold
  const origin = makePort('origin', 0, 0);
  const destination = makePort('destination', 300, 400);

  const result = expectOk(
    planRoute({
      serverId: SERVER,
      origin,
      destination,
      originState: makePortState('origin'),
      destinationState: makePortState('destination', { taxPercent: 10, dockingFee: 50 }),
      ship: makeShip('trader', 7, 100),
      goods: [makeGood('alpha', 10), makeGood('beta', 25)],
      prices: [
        makePrice('origin', 'alpha', { buy: 100, stock: 6 }),
        makePrice('destination', 'alpha', { sell: 150 }),
        makePrice('origin', 'beta', { buy: 200, stock: null }),
        makePrice('destination', 'beta', { sell: 260 }),
      ],
    }),
  );

  test('picks the exact hand-computed cargo', () => {
    const quantities = Object.fromEntries(result.plan.map((l) => [l.goodId, l.quantity]));
    expect(quantities).toEqual({ alpha: 6, beta: 1 });
  });

  test('every money figure matches the hand computation exactly', () => {
    const alpha = result.plan.find((l) => l.goodId === 'alpha')!;
    const beta = result.plan.find((l) => l.goodId === 'beta')!;

    expect(alpha.grossRevenue).toBe(900);
    expect(alpha.taxAmount).toBe(90);
    expect(alpha.purchaseCost).toBe(600);
    expect(alpha.netProfit).toBe(210);

    expect(beta.grossRevenue).toBe(260);
    expect(beta.taxAmount).toBe(26);
    expect(beta.purchaseCost).toBe(200);
    expect(beta.netProfit).toBe(34);

    expect(result.totalGrossRevenue).toBe(1160);
    expect(result.totalTax).toBe(116);
    expect(result.totalPurchaseCost).toBe(800);
    expect(result.dockingFee).toBe(50);
    expect(result.tripProfit).toBe(194);
    expect(result.totalWeightCarried).toBe(85);
  });

  test('distance is the exact straight line, in abstract units', () => {
    expect(result.distanceUnits).toBe(500);
  });

  test('all four metrics are computed', () => {
    expect(result.metrics.totalProfit).toBe(194);
    expect(result.metrics.profitPerWeight).toBeCloseTo(194 / 85, 12);
    expect(result.metrics.profitPerDistance).toBeCloseTo(194 / 500, 12);
    expect(result.metrics.roi).toBeCloseTo(194 / 800, 12);
  });
});

// ---------------------------------------------------------------------------
// 2. Knapsack optimality
// ---------------------------------------------------------------------------
describe('2. knapsack optimality', () => {
  // This exact case is in SPEC.md because it is verified to defeat
  // greedy-by-ratio. Most random inputs give the same answer either way, so a
  // greedy implementation would pass a randomly chosen test and give false
  // confidence. Greedy takes C first (best ratio) and reaches 230.
  const items = [
    { id: 'A', weight: 16, value: 30, maxQuantity: 6 },
    { id: 'B', weight: 10, value: 9, maxQuantity: 5 },
    { id: 'C', weight: 13, value: 28, maxQuantity: 5 },
  ];
  const CAPACITY = 120;

  test('returns the true optimum of 234, not the greedy 230', () => {
    expect(solveBoundedKnapsack(items, CAPACITY).totalValue).toBe(234);
  });

  test('greedy-by-ratio really does get this wrong', () => {
    // Proving the test has teeth: if this ever stops returning 230, the case
    // no longer distinguishes the two algorithms and must be replaced.
    let remaining = CAPACITY;
    let greedyTotal = 0;
    for (const item of [...items].sort((a, b) => b.value / b.weight - a.value / a.weight)) {
      const take = Math.min(item.maxQuantity, Math.floor(remaining / item.weight));
      greedyTotal += take * item.value;
      remaining -= take * item.weight;
    }
    expect(greedyTotal).toBe(230);
  });

  test('the returned quantities are real: they fit and add up', () => {
    const result = solveBoundedKnapsack(items, CAPACITY);
    let weight = 0;
    let value = 0;
    for (const pick of result.picks) {
      const item = items.find((i) => i.id === pick.id)!;
      expect(pick.quantity).toBeLessThanOrEqual(item.maxQuantity);
      expect(Number.isInteger(pick.quantity)).toBe(true);
      weight += pick.quantity * item.weight;
      value += pick.quantity * item.value;
    }
    expect(weight).toBeLessThanOrEqual(CAPACITY);
    expect(value).toBe(result.totalValue);
  });

  test('matches brute force across many random cases', () => {
    // Randomised cross-check, kept small enough to brute force exactly.
    let seed = 20260823;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };

    for (let trial = 0; trial < 200; trial++) {
      const cases = [
        { id: 'x', weight: 1 + rand(9), value: 1 + rand(40), maxQuantity: 1 + rand(6) },
        { id: 'y', weight: 1 + rand(9), value: 1 + rand(40), maxQuantity: 1 + rand(6) },
        { id: 'z', weight: 1 + rand(9), value: 1 + rand(40), maxQuantity: 1 + rand(6) },
      ];
      const capacity = 5 + rand(40);

      let best = 0;
      for (let a = 0; a <= cases[0]!.maxQuantity; a++) {
        for (let b = 0; b <= cases[1]!.maxQuantity; b++) {
          for (let c = 0; c <= cases[2]!.maxQuantity; c++) {
            const weight =
              a * cases[0]!.weight + b * cases[1]!.weight + c * cases[2]!.weight;
            if (weight > capacity) continue;
            const value = a * cases[0]!.value + b * cases[1]!.value + c * cases[2]!.value;
            if (value > best) best = value;
          }
        }
      }
      expect(solveBoundedKnapsack(cases, capacity).totalValue).toBe(best);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Integer money
// ---------------------------------------------------------------------------
describe('3. integer money', () => {
  // 4.2 and 18.9 are real observed prices and both are unrepresentable in
  // binary floating point, so a float implementation drifts on volume.
  const BUY = toTenths(4.2); // 42
  const SELL = toTenths(18.9); // 189
  const UNITS = 1000;

  const result = expectOk(
    planRoute({
      serverId: SERVER,
      origin: makePort('origin', 0, 0),
      destination: makePort('destination', 0, 100),
      originState: makePortState('origin'),
      destinationState: makePortState('destination', { taxPercent: 0, dockingFee: 0 }),
      ship: makeShip('bulk', 7, 5000),
      goods: [makeGood('ore', 5)],
      prices: [
        makePrice('origin', 'ore', { buy: BUY, stock: UNITS }),
        makePrice('destination', 'ore', { sell: SELL }),
      ],
    }),
  );

  test('conversion to tenths is exact', () => {
    expect(BUY).toBe(42);
    expect(SELL).toBe(189);
  });

  test('a 1000-unit transaction has no floating-point drift', () => {
    const line = result.plan[0]!;
    expect(line.quantity).toBe(UNITS);
    expect(line.purchaseCost).toBe(42_000); // 4200.0 gold
    expect(line.grossRevenue).toBe(189_000); // 18900.0 gold
    expect(line.netProfit).toBe(147_000); // 14700.0 gold
    expect(result.tripProfit).toBe(147_000);
  });

  test('the naive floating-point version really does drift', () => {
    // Demonstrates what is being avoided: accumulating a per-unit price in
    // gold, which is what a line-item loop written in floats would do.
    //
    // Note that `18.9 * 1000 - 4.2 * 1000` happens to come out exact, so a
    // test built on that would prove nothing. Accumulation is where it breaks.
    let naiveCost = 0;
    let naiveRevenue = 0;
    for (let i = 0; i < UNITS; i++) {
      naiveCost += 4.2;
      naiveRevenue += 18.9;
    }
    expect(naiveCost).not.toBe(4_200);
    expect(naiveRevenue).not.toBe(18_900);
    expect(naiveRevenue - naiveCost).not.toBe(14_700);

    // The integer path lands exactly on the right answer.
    expect(result.tripProfit).toBe(147_000);
    expect(result.tripProfit / 10).toBe(14_700);
  });

  test('every money field is a whole number of tenths', () => {
    const moneyFields = [
      result.tripProfit,
      result.totalPurchaseCost,
      result.totalGrossRevenue,
      result.totalTax,
      result.dockingFee,
      ...result.plan.flatMap((l) => [
        l.buyPrice,
        l.sellPrice,
        l.grossRevenue,
        l.taxAmount,
        l.purchaseCost,
        l.netProfit,
      ]),
    ];
    for (const value of moneyFields) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Rate gating
// ---------------------------------------------------------------------------
describe('4. rate gating', () => {
  // "Shallow waters ranks VI-7" means only rate 6 and 7 hulls may dock AND
  // undock. Rate numbering runs opposite to size: 7 is the smallest.
  const shallow = makePort('shallow', 0, 0);
  const deep = makePort('deep', 100, 0);
  const shallowState = makePortState('shallow', { minShipRate: 6 });
  const deepState = makePortState('deep');

  const goods = [makeGood('cargo', 10)];
  const prices = [
    makePrice('shallow', 'cargo', { buy: 100, sell: 100 }),
    makePrice('deep', 'cargo', { buy: 100, sell: 200 }),
  ];

  const bigShip = makeShip('big', 3, 1000);
  const smallShip = makeShip('small', 7, 1000);

  test('a rate 3 ship is rejected when leaving the shallow port', () => {
    const result = planRoute({
      serverId: SERVER,
      origin: shallow,
      destination: deep,
      originState: shallowState,
      destinationState: deepState,
      ship: bigShip,
      goods,
      prices,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('ship_cannot_use_origin');
    // The message must carry the actual numbers, not a vague refusal.
    expect(result.message).toContain('rate 3');
    expect(result.message).toContain('rate 6');
  });

  test('a rate 3 ship is rejected when arriving at the shallow port', () => {
    const result = planRoute({
      serverId: SERVER,
      origin: deep,
      destination: shallow,
      originState: deepState,
      destinationState: shallowState,
      ship: bigShip,
      goods,
      prices,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('ship_cannot_use_destination');
  });

  test('a rate 7 ship may use the shallow port in both directions', () => {
    expect(
      planRoute({
        serverId: SERVER,
        origin: shallow,
        destination: deep,
        originState: shallowState,
        destinationState: deepState,
        ship: smallShip,
        goods,
        prices,
      }).ok,
    ).toBe(true);

    expect(
      planRoute({
        serverId: SERVER,
        origin: deep,
        destination: shallow,
        originState: deepState,
        destinationState: shallowState,
        ship: smallShip,
        goods,
        prices,
      }).ok,
    ).toBe(true);
  });

  test('a port with no recorded limit admits every ship', () => {
    expect(
      planRoute({
        serverId: SERVER,
        origin: deep,
        destination: makePort('other', 200, 0),
        originState: deepState,
        destinationState: makePortState('other'),
        ship: bigShip,
        goods,
        prices: [...prices, makePrice('other', 'cargo', { sell: 300 })],
      }).ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Same-port guard
// ---------------------------------------------------------------------------
describe('5. same-port guard', () => {
  const port = makePort('only', 10, 10);

  const result = planRoute({
    serverId: SERVER,
    origin: port,
    destination: port,
    originState: makePortState('only'),
    destinationState: makePortState('only'),
    ship: makeShip('ship', 7, 1000),
    goods: [makeGood('cargo', 5)],
    prices: [makePrice('only', 'cargo', { buy: 100, sell: 200 })],
  });

  test('is rejected rather than producing a plan', () => {
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('same_port');
  });

  test('never divides by zero distance', () => {
    // The guard runs before distance is used, so no Infinity or NaN can leak
    // into profit-per-distance.
    expect(JSON.stringify(result)).not.toContain('Infinity');
    expect(JSON.stringify(result)).not.toContain('null,"profitPerDistance"');
    expect(Object.values(result).some((v) => typeof v === 'number' && !Number.isFinite(v))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Null tax and null docking fee
// ---------------------------------------------------------------------------
describe('6. null tax and fee', () => {
  const result = expectOk(
    planRoute({
      serverId: SERVER,
      origin: makePort('origin', 0, 0),
      destination: makePort('destination', 100, 0),
      originState: makePortState('origin'),
      // Both unknown. Neither may be quietly replaced with a plausible default:
      // real observed tax runs from 4% to 12%, so 8% is not a safe guess.
      destinationState: makePortState('destination', { taxPercent: null, dockingFee: null }),
      ship: makeShip('ship', 7, 100),
      goods: [makeGood('cargo', 10)],
      prices: [
        makePrice('origin', 'cargo', { buy: 100, stock: 10 }),
        makePrice('destination', 'cargo', { sell: 150 }),
      ],
    }),
  );

  test('null tax is treated as zero, not as a guessed default', () => {
    expect(result.totalTax).toBe(0);
    // 10 units, 5.0 gold margin each, no tax, no fee.
    expect(result.tripProfit).toBe(500);
  });

  test('null docking fee is treated as zero', () => {
    expect(result.dockingFee).toBe(0);
  });

  test('both are flagged unverified on the result', () => {
    expect(result.unverified.taxUnknown).toBe(true);
    expect(result.unverified.dockingFeeUnverified).toBe(true);
  });

  test('the result says so in plain language', () => {
    const notes = result.notes.join(' ');
    expect(notes).toMatch(/tax .*unknown/i);
    expect(notes).toMatch(/docking fee is unverified/i);
    // And it must not claim a specific tax rate it does not have.
    expect(notes).not.toMatch(/assumed 8%/i);
  });

  test('a known tax is applied and not flagged', () => {
    const taxed = expectOk(
      planRoute({
        serverId: SERVER,
        origin: makePort('origin', 0, 0),
        destination: makePort('destination', 100, 0),
        originState: makePortState('origin'),
        destinationState: makePortState('destination', { taxPercent: 8, dockingFee: 25 }),
        ship: makeShip('ship', 7, 100),
        goods: [makeGood('cargo', 10)],
        prices: [
          makePrice('origin', 'cargo', { buy: 100, stock: 10 }),
          makePrice('destination', 'cargo', { sell: 150 }),
        ],
      }),
    );
    expect(taxed.unverified.taxUnknown).toBe(false);
    expect(taxed.unverified.dockingFeeUnverified).toBe(false);
    // gross 1500, tax ceil(1500 * 800 / 10000) = 120, cost 1000, fee 25.
    expect(taxed.totalTax).toBe(120);
    expect(taxed.tripProfit).toBe(1500 - 120 - 1000 - 25);
  });

  test('tax rounds up, so quoted profit is never optimistic', () => {
    // gross 3905 at 8% is 312.4 tenths, which must be charged as 313.
    const rounded = expectOk(
      planRoute({
        serverId: SERVER,
        origin: makePort('origin', 0, 0),
        destination: makePort('destination', 100, 0),
        originState: makePortState('origin'),
        destinationState: makePortState('destination', { taxPercent: 8, dockingFee: 0 }),
        ship: makeShip('ship', 7, 55),
        goods: [makeGood('cargo', 1)],
        prices: [
          makePrice('origin', 'cargo', { buy: 10, stock: 55 }),
          makePrice('destination', 'cargo', { sell: 71 }),
        ],
      }),
    );
    expect(rounded.plan[0]!.grossRevenue).toBe(3905);
    expect(rounded.totalTax).toBe(313);
  });
});

// ---------------------------------------------------------------------------
// 7. Stock limiting
// ---------------------------------------------------------------------------
describe('7. stock limiting', () => {
  const result = expectOk(
    planRoute({
      serverId: SERVER,
      origin: makePort('origin', 0, 0),
      destination: makePort('destination', 100, 0),
      originState: makePortState('origin'),
      destinationState: makePortState('destination', { taxPercent: 0, dockingFee: 0 }),
      // Hold is far larger than the stock available, so stock has to be what
      // stops the plan rather than capacity.
      ship: makeShip('big', 7, 10_000),
      goods: [makeGood('scarce', 5), makeGood('plentiful', 10)],
      prices: [
        makePrice('origin', 'scarce', { buy: 100, stock: 7 }),
        makePrice('destination', 'scarce', { sell: 400 }),
        makePrice('origin', 'plentiful', { buy: 100, stock: 300 }),
        makePrice('destination', 'plentiful', { sell: 150 }),
      ],
    }),
  );

  test('never plans more units than are in stock', () => {
    const scarce = result.plan.find((l) => l.goodId === 'scarce')!;
    const plentiful = result.plan.find((l) => l.goodId === 'plentiful')!;
    expect(scarce.quantity).toBe(7);
    expect(plentiful.quantity).toBe(300);
  });

  test('a good recorded as zero stock is excluded with a reason', () => {
    const empty = expectOk(
      planRoute({
        serverId: SERVER,
        origin: makePort('origin', 0, 0),
        destination: makePort('destination', 100, 0),
        originState: makePortState('origin'),
        destinationState: makePortState('destination'),
        ship: makeShip('ship', 7, 1000),
        goods: [makeGood('none', 5)],
        prices: [
          makePrice('origin', 'none', { buy: 100, stock: 0 }),
          makePrice('destination', 'none', { sell: 400 }),
        ],
      }),
    );
    expect(empty.plan).toHaveLength(0);
    expect(empty.excluded.map((e) => e.reason)).toContain('out_of_stock');
  });
});

// ---------------------------------------------------------------------------
// 8. Empty result
// ---------------------------------------------------------------------------
describe('8. empty result', () => {
  const result = planRoute({
    serverId: SERVER,
    origin: makePort('origin', 0, 0),
    destination: makePort('destination', 100, 0),
    originState: makePortState('origin'),
    destinationState: makePortState('destination', { taxPercent: 0, dockingFee: 0 }),
    ship: makeShip('ship', 7, 1000),
    goods: [makeGood('losing', 5), makeGood('flat', 5)],
    prices: [
      // Sells for less than it costs.
      makePrice('origin', 'losing', { buy: 200 }),
      makePrice('destination', 'losing', { sell: 150 }),
      // Breaks exactly even, which is not a profit.
      makePrice('origin', 'flat', { buy: 200 }),
      makePrice('destination', 'flat', { sell: 200 }),
    ],
  });

  test('is a successful result, not an error', () => {
    expect(result.ok).toBe(true);
  });

  test('returns an empty plan with a helpful explanation', () => {
    const ok = expectOk(result);
    expect(ok.plan).toHaveLength(0);
    expect(ok.tripProfit).toBe(0);
    expect(ok.emptyReason).toBeTruthy();
    expect(ok.emptyReason).toMatch(/not a failure|profitably|enough price data/i);
  });

  test('says which goods were dropped and why', () => {
    const ok = expectOk(result);
    expect(ok.excluded.map((e) => e.goodId).sort()).toEqual(['flat', 'losing']);
    for (const excluded of ok.excluded) {
      expect(excluded.reason).toBe('not_profitable');
      expect(excluded.message.length).toBeGreaterThan(0);
    }
  });

  test('metrics that would divide by zero come back null, not NaN', () => {
    const ok = expectOk(result);
    expect(ok.metrics.profitPerWeight).toBeNull();
    expect(ok.metrics.roi).toBeNull();
    expect(ok.metrics.profitPerDistance).toBe(0);
  });

  test('a route with no price data at all explains that instead', () => {
    const noData = expectOk(
      planRoute({
        serverId: SERVER,
        origin: makePort('origin', 0, 0),
        destination: makePort('destination', 100, 0),
        originState: makePortState('origin'),
        destinationState: makePortState('destination'),
        ship: makeShip('ship', 7, 1000),
        goods: [makeGood('unknown', 5)],
        prices: [],
      }),
    );
    expect(noData.plan).toHaveLength(0);
    expect(noData.emptyReason).toMatch(/not enough price data/i);
  });
});

// ---------------------------------------------------------------------------
// 9. Null stock
// ---------------------------------------------------------------------------
describe('9. null stock', () => {
  // Getting this wrong returns an empty cargo plan for every trade good, which
  // is a silent total failure rather than an obvious crash. The Market screen
  // shows no quantity for the 20 trade goods, so null stock is the NORMAL case.
  const base = {
    serverId: SERVER,
    origin: makePort('origin', 0, 0),
    destination: makePort('destination', 100, 0),
    originState: makePortState('origin'),
    destinationState: makePortState('destination', { taxPercent: 0, dockingFee: 0 }),
    ship: makeShip('ship', 7, 100),
    goods: [makeGood('unlimited', 10)],
  };

  test('a good with null stock is included, not excluded', () => {
    const result = expectOk(
      planRoute({
        ...base,
        prices: [
          makePrice('origin', 'unlimited', { buy: 100, stock: null }),
          makePrice('destination', 'unlimited', { sell: 200 }),
        ],
      }),
    );
    expect(result.plan).toHaveLength(1);
    expect(result.excluded).toHaveLength(0);
  });

  test('null stock is bounded by hold capacity, not treated as zero', () => {
    const result = expectOk(
      planRoute({
        ...base,
        prices: [
          makePrice('origin', 'unlimited', { buy: 100, stock: null }),
          makePrice('destination', 'unlimited', { sell: 200 }),
        ],
      }),
    );
    // Hold 100, weight 10 per unit, so 10 units fill the hold exactly.
    expect(result.plan[0]!.quantity).toBe(10);
    expect(result.plan[0]!.stockWasUnknown).toBe(true);
    expect(result.totalWeightCarried).toBe(100);
  });

  test('null stock is also bounded by the gold available', () => {
    const result = expectOk(
      planRoute({
        ...base,
        // Only enough gold for 4 units at 10.0 gold each.
        availableGold: 450,
        prices: [
          makePrice('origin', 'unlimited', { buy: 100, stock: null }),
          makePrice('destination', 'unlimited', { sell: 200 }),
        ],
      }),
    );
    expect(result.plan[0]!.quantity).toBe(4);
    expect(result.totalPurchaseCost).toBeLessThanOrEqual(450);
  });

  test('null stock and zero stock are not the same thing', () => {
    const zero = expectOk(
      planRoute({
        ...base,
        prices: [
          makePrice('origin', 'unlimited', { buy: 100, stock: 0 }),
          makePrice('destination', 'unlimited', { sell: 200 }),
        ],
      }),
    );
    expect(zero.plan).toHaveLength(0);
    expect(zero.excluded[0]!.reason).toBe('out_of_stock');
  });
});

// ---------------------------------------------------------------------------
// 11. Real-data regression
// ---------------------------------------------------------------------------
describe('11. real-data regression', () => {
  // The two real price sets recorded in goods.json were read off the Market
  // tab, where the only control ever seen on a trade good is a greyed SELL
  // button. A Buy control has never been observed. So these are sell prices,
  // and neither port has a recorded buy price.
  //
  // The correct answer is therefore zero profitable goods in both directions,
  // and the reason must be the honest one: we do not know what these goods
  // cost to buy. This test exists to catch a calculator that hallucinates
  // profit out of near-identical numbers.
  const goodsJson = JSON.parse(
    readFileSync(join(repoRoot, 'data', 'goods.json'), 'utf8'),
  ) as {
    goods: { id: string; name: string; weight: number }[];
    _validationEvidence: {
      fijiBay_City: Record<string, number>;
      unnamedSettlement: Record<string, number>;
    };
  };

  const fiji = goodsJson._validationEvidence.fijiBay_City;
  const settlement = goodsJson._validationEvidence.unnamedSettlement;
  const goods = goodsJson.goods.map((g) => makeGood(g.id, g.weight, { name: g.name }));

  const fijiPort = makePort('fiji', 1454, 747);
  const settlementPort = makePort('settlement', 1582, 1162);

  // Observed prices are sell-side only, so buy stays null at both ports.
  const prices = [
    ...Object.entries(fiji).map(([goodId, gold]) =>
      makePrice('fiji', goodId, { buy: null, sell: toTenths(gold) }),
    ),
    ...Object.entries(settlement).map(([goodId, gold]) =>
      makePrice('settlement', goodId, { buy: null, sell: toTenths(gold) }),
    ),
  ];

  const trip = planTrip({
    serverId: SERVER,
    origin: fijiPort,
    destination: settlementPort,
    originState: makePortState('fiji', { taxPercent: 8 }),
    destinationState: makePortState('settlement', { taxPercent: 8 }),
    ship: makeShip('trader', 7, 11_000),
    goods,
    prices,
  });

  test('the fixture really is the full set of 20 observed goods', () => {
    expect(Object.keys(fiji)).toHaveLength(20);
    expect(Object.keys(settlement)).toHaveLength(20);
  });

  test('returns zero profitable goods outbound', () => {
    const result = expectOk(trip.outbound);
    expect(result.plan).toHaveLength(0);
    expect(result.tripProfit).toBe(0);
  });

  test('returns zero profitable goods on the return leg too', () => {
    const result = expectOk(trip.returnLeg);
    expect(result.plan).toHaveLength(0);
    expect(result.tripProfit).toBe(0);
  });

  test('every good is excluded for the honest reason', () => {
    const result = expectOk(trip.outbound);
    expect(result.excluded).toHaveLength(20);
    for (const excluded of result.excluded) {
      expect(excluded.reason).toBe('no_buy_price_at_origin');
    }
  });

  test('the empty state explains itself rather than erroring', () => {
    expect(expectOk(trip.outbound).emptyReason).toBeTruthy();
    expect(expectOk(trip.returnLeg).emptyReason).toBeTruthy();
  });

  test('even if a buy price did appear, these ports are too alike to profit', () => {
    // A stricter version of the same guard. If the buy control is ever found
    // and turns out to equal the displayed price, the answer stays zero:
    // the two ports differ by at most 0.1 gold and the 8% tax swallows it.
    const withBuy = expectOk(
      planRoute({
        serverId: SERVER,
        origin: fijiPort,
        destination: settlementPort,
        originState: makePortState('fiji', { taxPercent: 8 }),
        destinationState: makePortState('settlement', { taxPercent: 8 }),
        ship: makeShip('trader', 7, 11_000),
        goods,
        prices: [
          ...Object.entries(fiji).map(([goodId, gold]) =>
            makePrice('fiji', goodId, { buy: toTenths(gold), sell: toTenths(gold) }),
          ),
          ...Object.entries(settlement).map(([goodId, gold]) =>
            makePrice('settlement', goodId, { buy: toTenths(gold), sell: toTenths(gold) }),
          ),
        ],
      }),
    );
    expect(withBuy.plan).toHaveLength(0);
    expect(withBuy.excluded.every((e) => e.reason === 'not_profitable')).toBe(true);
  });
});
