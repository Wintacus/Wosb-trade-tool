import { describe, expect, test } from 'vitest';
import { canUsePort, portDistance } from '../domain/geo';
import { makePort } from './fixtures';

/**
 * Distance and rate gating, tested directly.
 *
 * Both are exercised through the calculator already, but they are the two
 * rules SPEC.md is most emphatic about, and a rule worth stating twice is
 * worth testing on its own.
 */

describe('rate gating', () => {
  // Rate numbering runs opposite to size: 7 is the smallest hull, 1 the
  // largest. "Shallow waters ranks VI-7" therefore means rate >= 6.
  test('a port with no recorded limit admits every rate', () => {
    for (let rate = 1; rate <= 7; rate++) {
      expect(canUsePort(rate, null)).toBe(true);
    }
  });

  test('a shallow port admits only its own rate and smaller hulls', () => {
    const admitted = [1, 2, 3, 4, 5, 6, 7].filter((rate) => canUsePort(rate, 6));
    expect(admitted).toEqual([6, 7]);
  });

  test('the smallest hull gets in everywhere', () => {
    for (let limit = 1; limit <= 7; limit++) {
      expect(canUsePort(7, limit)).toBe(true);
    }
  });

  test('the largest hull is turned away by any limit above 1', () => {
    expect(canUsePort(1, 1)).toBe(true);
    for (let limit = 2; limit <= 7; limit++) {
      expect(canUsePort(1, limit)).toBe(false);
    }
  });

  test('a nonsense limit is ignored rather than gating everything out', () => {
    // The database rejects these now, but the rule should not turn a bad row
    // into a port nobody can ever use.
    expect(canUsePort(5, Number.NaN)).toBe(true);
    expect(canUsePort(5, Number.POSITIVE_INFINITY)).toBe(true);
  });
});

describe('distance', () => {
  test('is the straight line between two points', () => {
    // 3-4-5, so the answer is exact rather than approximate.
    expect(portDistance(makePort('a', 0, 0), makePort('b', 300, 400))).toBe(500);
  });

  test('does not care which way round the ports are given', () => {
    const a = makePort('a', 1454, 747);
    const b = makePort('b', 1582, 1162);
    expect(portDistance(a, b)).toBe(portDistance(b, a));
  });

  test('is zero for a port and itself', () => {
    // Never divided by without the same-port guard running first.
    const a = makePort('a', 10, 10);
    expect(portDistance(a, a)).toBe(0);
  });

  test('handles the real map extremes without overflowing', () => {
    // Map bounds run to roughly 1800 x 1450.
    const distance = portDistance(makePort('a', 0, 0), makePort('b', 1800, 1450));
    expect(distance).toBeGreaterThan(2000);
    expect(Number.isFinite(distance)).toBe(true);
  });

  test('is symmetric under reflection, since only separation matters', () => {
    expect(portDistance(makePort('a', 0, 0), makePort('b', -300, -400))).toBe(500);
  });
});
