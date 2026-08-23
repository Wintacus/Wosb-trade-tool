import type { Port } from './types';

/**
 * Straight-line distance between two ports, in abstract map units.
 *
 * This is NEVER converted to travel time. Real time depends on wind direction,
 * sail configuration and cargo load, none of which the app can predict, so a
 * minutes figure would be invented precision (SPEC.md §4.2).
 */
export function portDistance(a: Port, b: Port): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Whether a ship may use a port at all.
 *
 * A port's `minShipRate` gates BOTH departure and arrival: a rate 3 ship cannot
 * dock at, or undock from, a "Shallow waters ranks VI-7" port. Rate numbering
 * runs the other way to size — 7 is the smallest hull — so the test is
 * `rate >= minShipRate`.
 *
 * Lighthouses do not bypass this; they are a travel-time mechanic only.
 */
export function canUsePort(shipRate: number, minShipRate: number | null): boolean {
  if (minShipRate === null || !Number.isFinite(minShipRate)) return true;
  return shipRate >= minShipRate;
}
