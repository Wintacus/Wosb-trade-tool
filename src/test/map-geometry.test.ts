import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { clusterPoints } from '../ui/cluster';
import { projectPorts } from '../ui/ports';
import { toPort } from '../data/mappers';
import type { Port } from '../domain/types';

/**
 * Map geometry, against the REAL 42 ports.
 *
 * This file exists because of a bug that every other test missed: the map's
 * clustering threshold (34 units) was smaller than the closest pair of actual
 * ports (54.6 units), so no cluster was ever drawn, the numbered-circle code
 * never ran once, and the on-screen hint described something that could not
 * happen. Synthetic fixtures would not have caught it — only the real
 * coordinates at a real phone size do.
 */

const PHONE = { width: 390, height: 600 };
/** Screen pixels below which markers merge. Mirrors PortMap. */
const CLUSTER_SEPARATION = 46;
/** The invisible tap target radius in PortMap: 22px gives a 44px target. */
const HIT_RADIUS = 22;

const ports: Port[] = (() => {
  const raw = JSON.parse(readFileSync(new URL('../../data/ports.json', import.meta.url), 'utf8'));
  const list = Array.isArray(raw.ports) ? raw.ports : [];
  return list.map((row: Record<string, unknown>) => toPort(row));
})();

function nearestNeighbours(points: { x: number; y: number }[]): number[] {
  return points.map((a, i) =>
    Math.min(
      ...points.filter((_, j) => j !== i).map((b) => Math.hypot(a.x - b.x, a.y - b.y)),
    ),
  );
}

describe('projection onto a phone-sized map', () => {
  it('reads all 42 real ports', () => {
    expect(ports).toHaveLength(42);
  });

  it('keeps every port inside the box', () => {
    // A port projected outside the viewBox is simply invisible, with nothing
    // on screen to say so.
    for (const point of projectPorts(ports, PHONE.width, PHONE.height)) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(PHONE.width);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(PHONE.height);
    }
  });

  it('preserves the aspect ratio, so distances are not misrepresented', () => {
    // Distance is the one thing this map measures. Two pairs of ports that are
    // equally far apart in the data must be equally far apart on screen,
    // whichever direction they lie in.
    const wide = projectPorts(ports, 800, 400);
    const tall = projectPorts(ports, 400, 800);
    const ratio = (points: { x: number; y: number }[]) => {
      const dx = Math.abs(points[0]!.x - points[1]!.x);
      const dy = Math.abs(points[0]!.y - points[1]!.y);
      return dy === 0 ? Infinity : dx / dy;
    };
    expect(ratio(wide)).toBeCloseTo(ratio(tall), 6);
  });

  it('scales with the box rather than assuming a fixed size', () => {
    const small = projectPorts(ports, 390, 600);
    const large = projectPorts(ports, 780, 1200);
    // Twice the box, twice the separation.
    const d = (p: { x: number; y: number }[]) => Math.hypot(p[0]!.x - p[1]!.x, p[0]!.y - p[1]!.y);
    expect(d(large) / d(small)).toBeCloseTo(2, 4);
  });
});

describe('clustering actually fires on real data (the bug this replaced)', () => {
  it('merges the ports that are too close to tap apart at default zoom', () => {
    const points = projectPorts(ports, PHONE.width, PHONE.height);
    const clusters = clusterPoints(points, CLUSTER_SEPARATION);
    const merged = clusters.filter((c) => c.members.length > 1);
    // The old threshold produced zero of these on this exact data, which made
    // the cluster rendering dead code and left overlapping markers untappable.
    expect(merged.length).toBeGreaterThan(0);
    expect(clusters.length).toBeLessThan(ports.length);
  });

  it('leaves no two drawn markers closer than a tap target', () => {
    // This is the property that matters: whatever the clustering does, what
    // ends up on screen must be separately tappable.
    const points = projectPorts(ports, PHONE.width, PHONE.height);
    const clusters = clusterPoints(points, CLUSTER_SEPARATION);
    for (const nearest of nearestNeighbours(clusters)) {
      expect(nearest).toBeGreaterThanOrEqual(HIT_RADIUS);
    }
  });

  it('separates every port again once zoomed in far enough', () => {
    // Zooming must eventually let the user reach any individual port, or a
    // clustered port becomes permanently unselectable on the map.
    const base = projectPorts(ports, PHONE.width, PHONE.height);
    const zoomed = base.map((p) => ({ ...p, x: p.x * 8, y: p.y * 8 }));
    const clusters = clusterPoints(zoomed, CLUSTER_SEPARATION);
    expect(clusters).toHaveLength(ports.length);
  });

  it('accounts for every port exactly once, at every zoom', () => {
    const base = projectPorts(ports, PHONE.width, PHONE.height);
    for (const scale of [1, 2, 4, 8]) {
      const scaled = base.map((p) => ({ ...p, x: p.x * scale, y: p.y * scale }));
      const ids = clusterPoints(scaled, CLUSTER_SEPARATION)
        .flatMap((c) => c.members.map((m) => m.id))
        .sort();
      expect(ids).toHaveLength(ports.length);
      expect(new Set(ids).size).toBe(ports.length);
    }
  });
});
