import { describe, expect, it } from 'vitest';
import { clusterPoints } from '../ui/cluster';
import { portAvailability, portBounds, portLabel, searchPorts } from '../ui/ports';
import { makePort, makePortState } from './fixtures';

describe('port search (the list is an equal alternative to the map)', () => {
  const ports = [
    makePort('havana', 10, 10, { name: 'havana', displayName: 'Havana' }),
    makePort('new-havana', 20, 20, { name: 'new-havana', displayName: 'New Havana' }),
    makePort('avilas', 30, 30, { name: 'avilas', displayName: 'Avilés' }),
    makePort('charleston', 40, 40, { name: 'charleston', displayName: 'Charleston' }),
  ];

  it('returns everything, alphabetically, for an empty query', () => {
    expect(searchPorts(ports, '').map(portLabel)).toEqual([
      'Avilés',
      'Charleston',
      'Havana',
      'New Havana',
    ]);
  });

  it('ranks an exact match above a prefix above a mere substring', () => {
    expect(searchPorts(ports, 'havana').map(portLabel)).toEqual(['Havana', 'New Havana']);
  });

  it('is case-insensitive and tolerates surrounding spaces', () => {
    expect(searchPorts(ports, '  CHARLES ').map(portLabel)).toEqual(['Charleston']);
  });

  it('finds an accented name typed without the accent', () => {
    // A phone keyboard makes "é" genuinely awkward, and the seed data has
    // several accented port names.
    expect(searchPorts(ports, 'aviles').map(portLabel)).toEqual(['Avilés']);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(searchPorts(ports, 'zzz')).toEqual([]);
  });
});

describe('port availability (SPEC 6.6)', () => {
  const port = makePort('nassau', 5, 5, { displayName: 'Nassau' });

  it('prevents picking the same port at both ends rather than erroring later', () => {
    const result = portAvailability(port, null, 5, 'nassau');
    expect(result.selectable).toBe(false);
    expect(result.reason).toBe('same_port');
  });

  it('excludes a port with no market, and says so', () => {
    const state = makePortState('nassau', { hasMarket: false });
    const result = portAvailability(port, state, 5, null);
    expect(result.selectable).toBe(false);
    expect(result.message).toContain('no market');
  });

  it('explains a rate restriction with the actual numbers', () => {
    // Rate numbering runs opposite to size: 7 is the smallest hull, so a
    // min of 5 shuts out the *bigger* rate-4 ship, not the smaller one.
    const state = makePortState('nassau', { minShipRate: 5 });
    const result = portAvailability(port, state, 4, null);
    expect(result.selectable).toBe(false);
    expect(result.reason).toBe('ship_rate');
    expect(result.message).toContain('rate 5');
    expect(result.message).toContain('rate 4');
  });

  it('allows a port whose restriction the ship satisfies', () => {
    const state = makePortState('nassau', { minShipRate: 5 });
    expect(portAvailability(port, state, 6, null).selectable).toBe(true);
  });

  it('allows a port whose market has never been recorded', () => {
    // Unknown is not the same as absent. Refusing unrecorded ports would hide
    // most of the map before anyone has entered data.
    expect(portAvailability(port, null, 5, null).selectable).toBe(true);
  });

  it('ignores rate gating until a ship is chosen', () => {
    const state = makePortState('nassau', { minShipRate: 7 });
    expect(portAvailability(port, state, null, null).selectable).toBe(true);
  });
});

describe('map bounds', () => {
  it('is computed from the ports themselves, never hardcoded', () => {
    const bounds = portBounds([makePort('a', 0, 0), makePort('b', 100, 50)], 0);
    expect(bounds).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 50 });
  });

  it('pads the box so edge markers are not clipped', () => {
    const bounds = portBounds([makePort('a', 0, 0), makePort('b', 100, 100)], 0.1);
    expect(bounds.minX).toBe(-10);
    expect(bounds.maxX).toBe(110);
  });

  it('survives a single port without producing a zero-sized box', () => {
    const bounds = portBounds([makePort('only', 7, 7)], 0);
    expect(bounds.maxX - bounds.minX).toBeGreaterThan(0);
    expect(bounds.maxY - bounds.minY).toBeGreaterThan(0);
  });

  it('survives an empty list', () => {
    expect(portBounds([]).maxX).toBeGreaterThan(portBounds([]).minX);
  });
});

describe('marker clustering', () => {
  const points = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 3, y: 0 },
    { id: 'c', x: 100, y: 100 },
  ];

  it('merges markers that would overlap', () => {
    const clusters = clusterPoints(points, 10);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.members.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('separates them again as zoom pushes them apart', () => {
    expect(clusterPoints(points, 1)).toHaveLength(3);
  });

  it('keeps every point exactly once', () => {
    const clusters = clusterPoints(points, 50);
    const ids = clusters.flatMap((c) => c.members.map((m) => m.id)).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('draws a cluster at the centre of its members', () => {
    const clusters = clusterPoints(
      [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 4, y: 0 },
      ],
      10,
    );
    expect(clusters[0]!.x).toBe(2);
  });

  it('does nothing at all when clustering is switched off', () => {
    expect(clusterPoints(points, 0)).toHaveLength(3);
  });
});
