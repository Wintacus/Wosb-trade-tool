import type { BasisPoints, Tenths } from './types';

/**
 * Money helpers. Every function here takes and returns integers.
 *
 * The rule (CLAUDE.md hard rule 3) is that no float ever represents currency.
 * JavaScript has one number type, so "integer" here means: the value is a
 * mathematical integer and every operation keeps it below 2^53, where doubles
 * represent integers exactly. `assertExactInteger` enforces that at the edges.
 */

/** Largest integer a JS number represents exactly. */
export const MAX_EXACT = Number.MAX_SAFE_INTEGER;

export function assertExactInteger(value: number, label: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer, got ${value}`);
  }
  if (Math.abs(value) > MAX_EXACT) {
    throw new Error(`${label} exceeds exact-integer range: ${value}`);
  }
  return value;
}

/** Convert a price as displayed in game (4.2) to storage form (42). */
export function toTenths(displayedGold: number): Tenths {
  return Math.round(displayedGold * 10);
}

/** Render tenths as the game does: 42 -> "4.2". Display only. */
export function formatTenths(value: Tenths): string {
  const negative = value < 0;
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 10);
  const tenth = abs % 10;
  return `${negative ? '-' : ''}${whole}.${tenth}`;
}

/**
 * Convert a tax percentage to integer basis points.
 *
 * null means UNKNOWN, which becomes 0 for arithmetic — but the caller must
 * surface that as "tax unknown" on the result. Never substitute 8%
 * (CLAUDE.md hard rule 1; SPEC.md §5.3).
 */
export function taxToBasisPoints(taxPercent: number | null): BasisPoints {
  if (taxPercent === null || !Number.isFinite(taxPercent)) return 0;
  return Math.round(taxPercent * 100);
}

/**
 * Tax charged on a gross sale, rounded UP to the next whole tenth.
 *
 * Rounding up means the quoted profit is never higher than what the player
 * actually receives. An over-estimate presented confidently is the worse
 * failure, so the leftover fraction goes against us.
 */
export function taxOnGross(grossRevenue: Tenths, taxBp: BasisPoints): Tenths {
  if (taxBp <= 0 || grossRevenue <= 0) return 0;
  const numerator = grossRevenue * taxBp;
  assertExactInteger(numerator, 'tax numerator');
  return Math.ceil(numerator / 10_000);
}

/**
 * Profit per unit in a scaled integer space, used as the knapsack's objective.
 *
 * Scaling by 10,000 lets tax be applied exactly without rounding inside the
 * optimiser: the solver maximises true (unrounded) profit, and the conservative
 * per-good rounding above is applied once, afterwards, when reporting.
 *
 *   scaled = sell * (10000 - taxBp) - buy * 10000
 */
export function unitValueScaled(
  sellPrice: Tenths,
  buyPrice: Tenths,
  taxBp: BasisPoints,
): number {
  const value = sellPrice * (10_000 - taxBp) - buyPrice * 10_000;
  return assertExactInteger(value, 'scaled unit value');
}
