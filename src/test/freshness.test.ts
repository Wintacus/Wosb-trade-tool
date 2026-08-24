import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  FRESHNESS_CLASS,
  ageText,
  freshnessFor,
  levelFor,
  worstFreshness,
} from '../ui/freshness';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-08-24T12:00:00.000Z');

function at(hoursAgo: number): string {
  return new Date(NOW - hoursAgo * HOUR).toISOString();
}

describe('freshness bands (SPEC 6.3)', () => {
  it('bands each age exactly as the spec table says', () => {
    expect(freshnessFor(at(0.5), NOW).level).toBe('fresh');
    expect(freshnessFor(at(3), NOW).level).toBe('aging');
    expect(freshnessFor(at(12), NOW).level).toBe('stale');
    expect(freshnessFor(at(48), NOW).level).toBe('wrong');
    expect(freshnessFor(null, NOW).level).toBe('none');
  });

  it('puts each boundary in the older band, so nothing is flattered', () => {
    // Exactly one hour old is "aging", not "fresh": the optimistic reading of a
    // boundary is the one that misleads.
    expect(levelFor(1 * HOUR, DEFAULT_THRESHOLDS)).toBe('aging');
    expect(levelFor(6 * HOUR, DEFAULT_THRESHOLDS)).toBe('stale');
    expect(levelFor(24 * HOUR, DEFAULT_THRESHOLDS)).toBe('wrong');
    expect(levelFor(1 * HOUR - 1, DEFAULT_THRESHOLDS)).toBe('fresh');
  });

  it('never signals with colour alone: every band has an icon and a label', () => {
    for (const hours of [0.1, 3, 12, 48]) {
      const band = freshnessFor(at(hours), NOW);
      expect(band.icon).not.toBe('');
      expect(band.label).not.toBe('');
      expect(band.meaning).not.toBe('');
    }
    const none = freshnessFor(null, NOW);
    expect(none.icon).toBe('○');
    expect(none.label).toBe('No data');
  });

  it('gives every level a distinct icon, so the icon alone is enough', () => {
    const icons = [
      freshnessFor(at(0.1), NOW).icon,
      freshnessFor(at(3), NOW).icon,
      freshnessFor(at(12), NOW).icon,
      freshnessFor(at(48), NOW).icon,
      freshnessFor(null, NOW).icon,
    ];
    expect(new Set(icons).size).toBe(5);
  });

  it('has a colour class for every band', () => {
    for (const level of ['fresh', 'aging', 'stale', 'wrong', 'none'] as const) {
      expect(FRESHNESS_CLASS[level].dot).toBeTruthy();
      expect(FRESHNESS_CLASS[level].chip).toBeTruthy();
    }
  });

  it('treats an unparseable or empty timestamp as never recorded, not as ancient', () => {
    // "recorded badly" and "never recorded" are different problems. Reading a
    // broken timestamp as infinitely old would show a red "likely wrong" band
    // over a port that simply has a data bug.
    expect(freshnessFor('not a date', NOW).level).toBe('none');
    expect(freshnessFor('', NOW).level).toBe('none');
    expect(freshnessFor(undefined, NOW).level).toBe('none');
  });

  it('treats a future timestamp as fresh rather than as a negative age', () => {
    const band = freshnessFor(new Date(NOW + 5 * HOUR).toISOString(), NOW);
    expect(band.level).toBe('fresh');
    expect(band.ageText).toBe('just now');
  });

  it('honours caller-supplied thresholds, ready for the settings screen', () => {
    const tight = { freshMs: 60_000, agingMs: 120_000, staleMs: 180_000 };
    expect(freshnessFor(at(0.5), NOW, tight).level).toBe('wrong');
  });

  it('describes an age in words', () => {
    expect(ageText(null)).toBe('');
    expect(ageText(30_000)).toBe('just now');
    expect(ageText(60_000)).toBe('1 minute ago');
    expect(ageText(45 * 60_000)).toBe('45 minutes ago');
    expect(ageText(3 * HOUR)).toBe('3 hours ago');
    expect(ageText(72 * HOUR)).toBe('3 days ago');
  });

  it('reports the worst band of many, never the best', () => {
    // A cargo plan is only as trustworthy as its stalest price.
    expect(worstFreshness(['fresh', 'wrong', 'aging'])).toBe('wrong');
    expect(worstFreshness(['fresh', 'fresh'])).toBe('fresh');
    expect(worstFreshness(['stale', 'none'])).toBe('none');
    expect(worstFreshness([])).toBe('fresh');
  });
});
