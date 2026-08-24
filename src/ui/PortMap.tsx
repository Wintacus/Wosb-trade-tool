import { useMemo, useRef, useState } from 'react';
import type { Port, PortState } from '../domain/types';
import { clusterPoints } from './cluster';
import { FRESHNESS_CLASS, freshnessFor, type FreshnessThresholds } from './freshness';
import { portAvailability, portBounds, portLabel } from './ports';
import { Button } from './Ui';

/**
 * The functional map (SPEC 6.2). Illustration is Phase 5; this is coordinates
 * on a stylised background, and it has to be honest about what it shows.
 *
 * Two implementation notes worth knowing before changing anything here:
 *
 *  - The viewBox comes from the port coordinates themselves. They live in the
 *    database and are editable, so a hardcoded box would crop the map the first
 *    time one moved (CLAUDE.md rule 2).
 *  - Pan and zoom are plain pointer events rather than a library. Two pointers
 *    pinch; one drags. It keeps the bundle small and the behaviour predictable
 *    on a phone, which is the only device this is ever verified on.
 */

const MIN_SCALE = 1;
const MAX_SCALE = 8;
/** Screen pixels below which two markers are merged into a cluster. */
const CLUSTER_SEPARATION = 34;
const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 700;

interface Pointer {
  id: number;
  x: number;
  y: number;
}

export function PortMap({
  ports,
  portStates,
  observations,
  shipRate,
  otherPortId,
  onPick,
  now,
  thresholds,
  stepLabel,
}: {
  ports: readonly Port[];
  portStates: ReadonlyMap<string, PortState>;
  observations: ReadonlyMap<string, string>;
  shipRate: number | null;
  otherPortId: string | null;
  onPick: (port: Port) => void;
  now: number;
  thresholds?: FreshnessThresholds;
  stepLabel: string;
}) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [selected, setSelected] = useState<Port | null>(null);
  const pointers = useRef(new Map<number, Pointer>());
  const pinchDistance = useRef<number | null>(null);
  const dragged = useRef(false);

  const bounds = useMemo(() => portBounds(ports), [ports]);

  /** Port coordinates to the SVG's own coordinate space. */
  const project = useMemo(() => {
    const spanX = bounds.maxX - bounds.minX;
    const spanY = bounds.maxY - bounds.minY;
    // Preserve the aspect ratio: stretching the sea would misrepresent every
    // distance on screen, and distance is the one thing the map is measuring.
    const fit = Math.min(VIEW_WIDTH / spanX, VIEW_HEIGHT / spanY);
    const marginX = (VIEW_WIDTH - spanX * fit) / 2;
    const marginY = (VIEW_HEIGHT - spanY * fit) / 2;
    return (port: Port) => ({
      x: (port.x - bounds.minX) * fit + marginX,
      y: (port.y - bounds.minY) * fit + marginY,
    });
  }, [bounds]);

  const clusters = useMemo(() => {
    const points = ports.map((port) => ({ id: port.id, port, ...project(port) }));
    // The threshold is in SVG units, so dividing by the zoom scale keeps the
    // separation constant in real screen pixels as the user zooms in.
    return clusterPoints(points, CLUSTER_SEPARATION / scale);
  }, [ports, project, scale]);

  function clampOffset(next: { x: number; y: number }, atScale: number) {
    // Never let the map be dragged entirely off screen.
    const maxX = (VIEW_WIDTH * (atScale - 1)) / 2;
    const maxY = (VIEW_HEIGHT * (atScale - 1)) / 2;
    return {
      x: Math.max(-maxX, Math.min(maxX, next.x)),
      y: Math.max(-maxY, Math.min(maxY, next.y)),
    };
  }

  function zoomTo(nextScale: number) {
    const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScale));
    setScale(clamped);
    setOffset((current) => clampOffset(current, clamped));
  }

  function onPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    (event.target as Element).setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    });
    dragged.current = false;
  }

  function onPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, current);

    const all = [...pointers.current.values()];
    if (all.length >= 2) {
      const [a, b] = all;
      const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinchDistance.current !== null && pinchDistance.current > 0) {
        zoomTo(scale * (distance / pinchDistance.current));
      }
      pinchDistance.current = distance;
      dragged.current = true;
      return;
    }

    const dx = current.x - previous.x;
    const dy = current.y - previous.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragged.current = true;
    setOffset((offsetNow) => clampOffset({ x: offsetNow.x + dx, y: offsetNow.y + dy }, scale));
  }

  function onPointerUp(event: React.PointerEvent<SVGSVGElement>) {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinchDistance.current = null;
  }

  function reset() {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }

  const selectedState = selected ? (portStates.get(selected.id) ?? null) : null;
  const selectedAvailability = selected
    ? portAvailability(selected, selectedState, shipRate, otherPortId)
    : null;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
        <p className="text-sm text-slate-400">
          Drag to pan, pinch or use the buttons to zoom. Tap a marker to pick it.
        </p>
        <div className="flex gap-2">
          <Button onClick={() => zoomTo(scale * 1.5)} ariaLabel="Zoom in" className="px-3">
            +
          </Button>
          <Button onClick={() => zoomTo(scale / 1.5)} ariaLabel="Zoom out" className="px-3">
            −
          </Button>
          <Button onClick={reset} className="px-3">
            Reset
          </Button>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        role="application"
        aria-label={`Map of ports. ${stepLabel}. A searchable list of the same ports is on the other tab.`}
        className="w-full touch-none rounded-xl border border-slate-800 bg-slate-950 select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          <pattern id="sea" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M0 20 Q10 14 20 20 T40 20" fill="none" stroke="#1e293b" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill="#020617" />
        <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill="url(#sea)" opacity="0.7" />

        <g transform={`translate(${offset.x} ${offset.y}) scale(${scale})`}>
          {clusters.map((cluster) => {
            if (cluster.members.length > 1) {
              return (
                <g
                  key={cluster.id}
                  onClick={() => !dragged.current && zoomTo(scale * 2)}
                  className="cursor-zoom-in"
                >
                  <circle
                    cx={cluster.x}
                    cy={cluster.y}
                    r={14 / scale}
                    fill="#1e293b"
                    stroke="#64748b"
                    strokeWidth={2 / scale}
                  />
                  <text
                    x={cluster.x}
                    y={cluster.y + 4 / scale}
                    textAnchor="middle"
                    fontSize={12 / scale}
                    fill="#e2e8f0"
                  >
                    {cluster.members.length}
                  </text>
                </g>
              );
            }

            const { port, x, y } = cluster.members[0]!;
            const state = portStates.get(port.id) ?? null;
            const availability = portAvailability(port, state, shipRate, otherPortId);
            const band = freshnessFor(observations.get(port.id) ?? null, now, thresholds);
            const isSelected = selected?.id === port.id;

            return (
              <g
                key={port.id}
                onClick={() => {
                  if (dragged.current) return;
                  setSelected(port);
                }}
                className="cursor-pointer"
                aria-label={`${portLabel(port)}, ${band.label}`}
              >
                {/* Marker primary visual is freshness; faction is a small badge. */}
                <circle
                  cx={x}
                  cy={y}
                  r={(isSelected ? 11 : 7) / scale}
                  fill={FRESHNESS_CLASS[band.level].svgFill}
                  opacity={availability.selectable ? 1 : 0.35}
                  stroke={isSelected ? '#fbbf24' : '#0f172a'}
                  strokeWidth={(isSelected ? 3 : 1.5) / scale}
                />
                {/* The icon repeats the band without relying on the colour. */}
                <text
                  x={x}
                  y={y - 10 / scale}
                  textAnchor="middle"
                  fontSize={11 / scale}
                  fill="#e2e8f0"
                  opacity={availability.selectable ? 0.9 : 0.4}
                >
                  {band.icon}
                </text>
                {scale > 2 ? (
                  <text
                    x={x}
                    y={y + 18 / scale}
                    textAnchor="middle"
                    fontSize={11 / scale}
                    fill="#cbd5e1"
                  >
                    {portLabel(port)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>

      <div className="mt-3 min-h-24 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
        {selected && selectedAvailability ? (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium text-slate-100">{portLabel(selected)}</p>
              <p className="mt-1 text-xs text-slate-400">
                {freshnessFor(observations.get(selected.id) ?? null, now, thresholds).icon}{' '}
                {freshnessFor(observations.get(selected.id) ?? null, now, thresholds).label}
                {selectedState?.controllingFaction
                  ? ` · held by ${selectedState.controllingFaction}`
                  : ''}
              </p>
              {selectedAvailability.message ? (
                <p className="mt-1 text-sm text-amber-200/90">{selectedAvailability.message}</p>
              ) : null}
            </div>
            <Button
              variant="primary"
              disabled={!selectedAvailability.selectable}
              onClick={() => onPick(selected)}
            >
              Choose {portLabel(selected)}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-slate-400">
            Tap a marker to see the port, then confirm it. Markers show data freshness; a
            numbered circle means several ports are too close together to tap apart — zoom in.
          </p>
        )}
      </div>

      <MapLegend />
    </div>
  );
}

function MapLegend() {
  const entries = [
    { level: 'fresh', icon: '✓', label: 'Fresh, under 1 hour' },
    { level: 'aging', icon: '◷', label: 'Aging, 1–6 hours' },
    { level: 'stale', icon: '⚠', label: 'Stale, 6–24 hours' },
    { level: 'wrong', icon: '!', label: 'Likely wrong, over a day' },
    { level: 'none', icon: '○', label: 'Never recorded' },
  ] as const;
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
      {entries.map((entry) => (
        <li key={entry.level} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`size-2.5 rounded-full ${FRESHNESS_CLASS[entry.level].dot}`}
          />
          <span aria-hidden="true">{entry.icon}</span>
          <span>{entry.label}</span>
        </li>
      ))}
    </ul>
  );
}
