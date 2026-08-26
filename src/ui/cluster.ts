/**
 * Marker clustering for the map (SPEC 6.2).
 *
 * At low zoom several ports land on the same few pixels and a tap cannot pick
 * between them. Rather than let markers overlap, near-neighbours merge into one
 * marker showing a count, which expands as the user zooms in.
 *
 * Coordinates here are already in *screen* space, so the separation threshold
 * is a real distance in pixels and clustering loosens automatically as the zoom
 * scale grows. Nothing in this file knows anything about ports.
 */

export interface ClusterPoint {
  id: string;
  x: number;
  y: number;
}

export interface Cluster<T extends ClusterPoint> {
  /** Stable across renders: the id of the first member in input order. */
  id: string;
  /** Centre of the members, where the marker is drawn. */
  x: number;
  y: number;
  members: T[];
}

/**
 * Greedy single-pass clustering: each point joins the first cluster whose
 * centre is within `minSeparation`, otherwise it starts one.
 *
 * Greedy is the right choice here despite being approximate — the output is a
 * drawing, and the exact grouping at the margin does not change what a user can
 * reach, because zooming in separates them either way. (This is not the
 * knapsack; there, greedy would be wrong and is forbidden.)
 */
export function clusterPoints<T extends ClusterPoint>(
  points: readonly T[],
  minSeparation: number,
): Cluster<T>[] {
  const clusters: Cluster<T>[] = [];
  if (minSeparation <= 0) {
    return points.map((point) => ({ id: point.id, x: point.x, y: point.y, members: [point] }));
  }
  const threshold = minSeparation * minSeparation;

  for (const point of points) {
    let joined = false;
    for (const cluster of clusters) {
      const dx = cluster.x - point.x;
      const dy = cluster.y - point.y;
      if (dx * dx + dy * dy <= threshold) {
        cluster.members.push(point);
        // Re-centre on the running mean so a cluster tracks its members rather
        // than staying pinned to whichever point happened to arrive first.
        const n = cluster.members.length;
        cluster.x += (point.x - cluster.x) / n;
        cluster.y += (point.y - cluster.y) / n;
        joined = true;
        break;
      }
    }
    if (!joined) {
      clusters.push({ id: point.id, x: point.x, y: point.y, members: [point] });
    }
  }
  return clusters;
}
