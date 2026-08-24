import { canUsePort } from '../domain/geo';
import type { Port, PortState } from '../domain/types';

/** The name to show. displayName wins when the seed data carries one. */
export function portLabel(port: Port): string {
  return port.displayName ?? port.name;
}

export type PortBlockReason = 'same_port' | 'no_market' | 'ship_rate';

export interface PortAvailability {
  selectable: boolean;
  reason: PortBlockReason | null;
  /** Plain-language explanation with the actual numbers in it (SPEC 6.6). */
  message: string | null;
}

const AVAILABLE: PortAvailability = { selectable: true, reason: null, message: null };

/**
 * Whether a port can be picked, and if not, why — in words a player can act on.
 *
 * SPEC 6.6 is explicit that the same port at both ends is *prevented* rather
 * than reported as an error afterwards, and that a rate restriction is
 * explained with the real numbers rather than a shrug.
 */
export function portAvailability(
  port: Port,
  state: PortState | null,
  shipRate: number | null,
  otherPortId: string | null,
): PortAvailability {
  if (otherPortId && port.id === otherPortId) {
    return {
      selectable: false,
      reason: 'same_port',
      message: `${portLabel(port)} is already the other end of this route.`,
    };
  }
  // hasMarket defaults to true when nobody has recorded it: unknown is not the
  // same as absent, and refusing an unrecorded port would hide most of the map.
  if (state && !state.hasMarket) {
    return {
      selectable: false,
      reason: 'no_market',
      message: `${portLabel(port)} has no market, so nothing can be bought or sold there.`,
    };
  }
  if (shipRate !== null && !canUsePort(shipRate, state?.minShipRate ?? null)) {
    return {
      selectable: false,
      reason: 'ship_rate',
      message:
        `${portLabel(port)} admits only rate ${state?.minShipRate} and higher-numbered ships. ` +
        `Your ship is rate ${shipRate}, so it can neither dock nor undock here.`,
    };
  }
  return AVAILABLE;
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    // Strip accents so "Aviles" finds "Avilés" — a phone keyboard makes the
    // accented character genuinely hard to type.
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

/**
 * Filter and rank ports for the searchable list.
 *
 * The list is an equal alternative to the map, not a fallback (SPEC 6.2), and
 * on a phone it is the faster of the two when you know the name — so ranking
 * matters: an exact match, then a name that starts with the query, then one
 * that merely contains it.
 */
export function searchPorts(ports: readonly Port[], query: string): Port[] {
  const needle = normalise(query);
  const scored = ports.map((port) => {
    const haystacks = [normalise(portLabel(port)), normalise(port.name)];
    if (needle === '') return { port, score: 0 };
    let score = -1;
    for (const hay of haystacks) {
      if (hay === needle) score = Math.max(score, 3);
      else if (hay.startsWith(needle)) score = Math.max(score, 2);
      else if (hay.includes(needle)) score = Math.max(score, 1);
    }
    return { port, score };
  });

  return scored
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || portLabel(a.port).localeCompare(portLabel(b.port)))
    .map((entry) => entry.port);
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * The rectangle containing every port, computed from the data rather than
 * written down. Port coordinates come from the database and are editable, so a
 * hardcoded viewBox would silently crop the map the first time one moves
 * (CLAUDE.md hard rule 2).
 */
export function portBounds(ports: readonly Port[], padding = 0.06): Bounds {
  if (ports.length === 0) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const port of ports) {
    if (port.x < minX) minX = port.x;
    if (port.x > maxX) maxX = port.x;
    if (port.y < minY) minY = port.y;
    if (port.y > maxY) maxY = port.y;
  }
  // A single port, or a perfectly vertical line of them, would give a zero-width
  // box: a viewBox of zero width divides by zero when scaling to the screen.
  // Padding alone does not save it, because a proportion of zero is zero.
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const halfWidth = width / 2 + width * padding;
  const halfHeight = height / 2 + height * padding;
  return {
    minX: cx - halfWidth,
    minY: cy - halfHeight,
    maxX: cx + halfWidth,
    maxY: cy + halfHeight,
  };
}
