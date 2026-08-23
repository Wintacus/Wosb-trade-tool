/**
 * Exact bounded knapsack.
 *
 * SPEC.md §5.5 is explicit that a greedy approximation is not acceptable: once
 * stock limits and whole-unit quantities exist, greedy-by-ratio is provably
 * wrong (§5.9 test 2 is a case where greedy returns 230 and the optimum is 234).
 *
 * The algorithm is the standard monotone-deque bounded knapsack, which is
 * O(items x capacity) — the ~3.3M cells SPEC.md §5.5 budgets for the worst case
 * (54,000 hold x 61 goods). Every stored value is a mathematical integer held in
 * a Float64Array; `assertCapacityForExactMath` guarantees no value can reach the
 * point where a double stops representing integers exactly.
 */
import { MAX_EXACT } from './money';

export interface KnapsackItem {
  id: string;
  /** Weight per unit. Must be a positive integer. */
  weight: number;
  /** Profit per unit in scaled integer units. Items with value <= 0 are dropped. */
  value: number;
  /** Maximum units available (stock, affordability and capacity already applied). */
  maxQuantity: number;
}

export interface KnapsackPick {
  id: string;
  quantity: number;
}

export interface KnapsackResult {
  totalValue: number;
  picks: KnapsackPick[];
}

function assertCapacityForExactMath(items: readonly KnapsackItem[], capacity: number): void {
  let upperBound = 0;
  for (const item of items) {
    const units = Math.min(item.maxQuantity, Math.floor(capacity / item.weight));
    upperBound += units * item.value;
  }
  if (upperBound > MAX_EXACT) {
    throw new Error(
      `Knapsack objective could reach ${upperBound}, beyond exact integer range. ` +
        'Refusing to compute rather than return a silently rounded profit.',
    );
  }
}

export function solveBoundedKnapsack(
  items: readonly KnapsackItem[],
  capacity: number,
): KnapsackResult {
  const W = Math.floor(capacity);
  const usable = items.filter(
    (i) =>
      Number.isInteger(i.weight) &&
      i.weight > 0 &&
      i.value > 0 &&
      i.maxQuantity > 0 &&
      i.weight <= W,
  );

  if (W <= 0 || usable.length === 0) return { totalValue: 0, picks: [] };

  assertCapacityForExactMath(usable, W);

  let prev = new Float64Array(W + 1);
  let cur = new Float64Array(W + 1);

  // takes[i][w] = how many units of item i the optimum takes at capacity w.
  const takes: Uint32Array[] = [];

  // Deque scratch buffers, allocated once and reused across every residue class.
  const dequeIndex = new Int32Array(W + 2);
  const dequeValue = new Float64Array(W + 2);

  for (const item of usable) {
    const { weight, value } = item;
    const bound = Math.min(item.maxQuantity, Math.floor(W / weight));
    const take = new Uint32Array(W + 1);

    // Positions that share a remainder mod `weight` form an independent chain,
    // because adding a unit always moves exactly one step along that chain.
    for (let residue = 0; residue < weight && residue <= W; residue++) {
      const steps = Math.floor((W - residue) / weight);
      let head = 0;
      let tail = -1;

      for (let j = 0; j <= steps; j++) {
        const at = residue + j * weight;
        // g(j) rebases the running profit so entries stay comparable across j.
        const g = prev[at]! - j * value;

        while (tail >= head && dequeValue[tail]! <= g) tail--;
        tail++;
        dequeIndex[tail] = j;
        dequeValue[tail] = g;

        // Drop candidates that would need more than `bound` units of this item.
        while (dequeIndex[head]! < j - bound) head++;

        cur[at] = dequeValue[head]! + j * value;
        take[at] = j - dequeIndex[head]!;
      }
    }

    takes.push(take);
    const swap = prev;
    prev = cur;
    cur = swap;
  }

  // Walk the layers backwards to recover the quantities behind the best value.
  const picks: KnapsackPick[] = [];
  let remaining = W;
  for (let i = usable.length - 1; i >= 0; i--) {
    const quantity = takes[i]![remaining]!;
    if (quantity > 0) {
      picks.push({ id: usable[i]!.id, quantity });
      remaining -= quantity * usable[i]!.weight;
    }
  }
  picks.reverse();

  return { totalValue: prev[W]!, picks };
}
