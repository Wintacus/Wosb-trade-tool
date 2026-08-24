import { describe, expect, it } from 'vitest';
import { latestObservationByPort, portsWithPrices } from '../data/queries';
import { makePrice } from './fixtures';

describe('map marker freshness', () => {
  const prices = [
    makePrice('havana', 'rum', { buy: 10 }, { observedAt: '2026-08-24T09:00:00.000Z' }),
    makePrice('havana', 'silk', { buy: 20 }, { observedAt: '2026-08-24T11:00:00.000Z' }),
    makePrice('nassau', 'rum', { sell: 30 }, { observedAt: '2026-08-20T11:00:00.000Z' }),
  ];

  it('dates a port by its most recent observation', () => {
    // The marker answers "has anyone been here lately", which is a question
    // about the last visit — unlike a single price row, where the older of the
    // two observations is what decides how much to trust the number.
    const latest = latestObservationByPort(prices);
    expect(latest.get('havana')).toBe('2026-08-24T11:00:00.000Z');
    expect(latest.get('nassau')).toBe('2026-08-20T11:00:00.000Z');
  });

  it('leaves a port with no prices absent rather than dated', () => {
    // Absent becomes the grey "never recorded" band. A default date here would
    // paint an unvisited port as freshly checked.
    expect(latestObservationByPort(prices).has('tortuga')).toBe(false);
  });

  it('handles an empty price list', () => {
    expect(latestObservationByPort([]).size).toBe(0);
  });

  it('lists which ports have any price at all', () => {
    expect([...portsWithPrices(prices)].sort()).toEqual(['havana', 'nassau']);
  });
});
