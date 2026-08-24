/**
 * Data freshness banding (SPEC.md 6.3).
 *
 * The rule that matters here: colour is never the only signal. Every band
 * carries an icon and a text label as well, so the meaning survives
 * colour-blindness, a sun-washed phone screen, and a screen reader.
 *
 * Thresholds are values, not laws — SPEC 6.3 says they become user-adjustable.
 * They are passed in everywhere rather than read from a constant so that a
 * settings screen can supply different ones without touching this logic.
 */

export type FreshnessLevel = 'fresh' | 'aging' | 'stale' | 'wrong' | 'none';

export interface FreshnessThresholds {
  /** Below this age, a price is fresh. Milliseconds. */
  freshMs: number;
  /** Below this age, a price is aging. */
  agingMs: number;
  /** Below this age, a price is stale. At or above it, likely wrong. */
  staleMs: number;
}

const HOUR = 60 * 60 * 1000;

/**
 * SPEC.md 6.3: under 1 hour fresh, 1-6 hours aging, 6-24 hours stale,
 * over 24 hours likely wrong.
 *
 * The bands are a confidence signal rather than a guarantee: the Market
 * refreshes its offers every day or two, but player buying and selling moves
 * prices continuously in between.
 */
export const DEFAULT_THRESHOLDS: FreshnessThresholds = {
  freshMs: 1 * HOUR,
  agingMs: 6 * HOUR,
  staleMs: 24 * HOUR,
};

export interface Freshness {
  level: FreshnessLevel;
  /** Second signal: shown next to the colour, never instead of the label. */
  icon: string;
  /** Third signal: always rendered, and read out by screen readers. */
  label: string;
  meaning: string;
  /** How long ago, in words. Empty when nothing was ever recorded. */
  ageText: string;
  /** Milliseconds since the observation, or null when there is none. */
  ageMs: number | null;
}

const MEANING: Record<FreshnessLevel, string> = {
  fresh: 'Recorded within the last hour.',
  aging: 'A few hours old. Prices move as players trade.',
  stale: 'Most of a day old. Treat the numbers as a rough guide.',
  wrong: 'Over a day old. This is likely wrong by now.',
  none: 'Nobody has ever recorded a price here.',
};

const ICON: Record<FreshnessLevel, string> = {
  fresh: '✓',
  aging: '◷',
  stale: '⚠',
  wrong: '!',
  none: '○',
};

const LABEL: Record<FreshnessLevel, string> = {
  fresh: 'Fresh',
  aging: 'Aging',
  stale: 'Stale',
  wrong: 'Likely wrong',
  none: 'No data',
};

/**
 * Tailwind classes per band. Kept beside the icon and label deliberately: a
 * component that reaches for the colour gets the other two signals in the same
 * object and has to go out of its way to drop them.
 */
export const FRESHNESS_CLASS: Record<
  FreshnessLevel,
  { dot: string; text: string; chip: string; svgFill: string }
> = {
  // svgFill is a real colour value rather than a class: a Tailwind background
  // utility does nothing to an SVG shape's fill.
  fresh: {
    dot: 'bg-emerald-400',
    text: 'text-emerald-300',
    chip: 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/40',
    svgFill: '#34d399',
  },
  aging: {
    dot: 'bg-yellow-300',
    text: 'text-yellow-200',
    chip: 'bg-yellow-500/15 text-yellow-100 ring-yellow-500/40',
    svgFill: '#fde047',
  },
  stale: {
    dot: 'bg-orange-400',
    text: 'text-orange-200',
    chip: 'bg-orange-500/15 text-orange-100 ring-orange-500/40',
    svgFill: '#fb923c',
  },
  wrong: {
    dot: 'bg-red-500',
    text: 'text-red-300',
    chip: 'bg-red-500/15 text-red-200 ring-red-500/40',
    svgFill: '#ef4444',
  },
  none: {
    dot: 'bg-slate-500',
    text: 'text-slate-400',
    chip: 'bg-slate-500/15 text-slate-300 ring-slate-500/40',
    svgFill: '#64748b',
  },
};

export function levelFor(ageMs: number | null, thresholds: FreshnessThresholds): FreshnessLevel {
  if (ageMs === null) return 'none';
  // A timestamp in the future means a clock disagreement, not a stale price.
  if (ageMs < thresholds.freshMs) return 'fresh';
  if (ageMs < thresholds.agingMs) return 'aging';
  if (ageMs < thresholds.staleMs) return 'stale';
  return 'wrong';
}

/** "14 minutes ago", "3 hours ago", "2 days ago". Empty for no observation. */
export function ageText(ageMs: number | null): string {
  if (ageMs === null) return '';
  if (ageMs < 0) return 'just now';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Band an observation timestamp.
 *
 * An absent, empty or unparseable timestamp is "no data" rather than
 * infinitely old: never recorded and recorded badly are different problems,
 * and neither should be presented as a price from a year ago.
 */
export function freshnessFor(
  observedAt: string | null | undefined,
  now: number,
  thresholds: FreshnessThresholds = DEFAULT_THRESHOLDS,
): Freshness {
  let ageMs: number | null = null;
  if (observedAt) {
    const parsed = Date.parse(observedAt);
    if (Number.isFinite(parsed)) ageMs = now - parsed;
  }
  const level = levelFor(ageMs, thresholds);
  return {
    level,
    icon: ICON[level],
    label: LABEL[level],
    meaning: MEANING[level],
    ageText: ageText(ageMs),
    ageMs,
  };
}

/**
 * The worst band among several — used when one number is built out of many
 * observations, such as a whole cargo plan or a port's entire price list.
 * Reporting the best of them would flatter the data.
 */
const SEVERITY: Record<FreshnessLevel, number> = {
  fresh: 0,
  aging: 1,
  stale: 2,
  wrong: 3,
  none: 4,
};

export function worstFreshness(levels: readonly FreshnessLevel[]): FreshnessLevel {
  let worst: FreshnessLevel = 'fresh';
  for (const level of levels) {
    if (SEVERITY[level] > SEVERITY[worst]) worst = level;
  }
  return worst;
}
