import { useEffect, useMemo, useRef, useState } from "react";
import type { Port, PortState } from "../domain/types";
import { clusterPoints } from "./cluster";
import {
  FRESHNESS_CLASS,
  freshnessFor,
  type FreshnessThresholds,
} from "./freshness";
import { portAvailability, portBounds, portLabel } from "./ports";
import { Button } from "./Ui";

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
 *
 * GESTURE CONTAINMENT — read this before "simplifying" the useEffect below.
 *
 * A user reported that pinching the map also zoomed the page and sometimes
 * switched apps. Four separate causes, three of which we can fix:
 *
 *  1. iOS Safari ignores `touch-action` for two-finger PAGE zoom. It fires its
 *     own non-standard `gesturestart` / `gesturechange` / `gestureend` events
 *     instead, and if nobody calls preventDefault on those, Safari zooms the
 *     whole document no matter what CSS says.
 *  2. React's synthetic events (onTouchMove and friends) are registered at the
 *     root as PASSIVE listeners, so calling preventDefault inside them does
 *     nothing — the browser has already committed to its default. Cancelling a
 *     touch therefore requires a NATIVE listener added with { passive: false }
 *     via a ref. Do not move this back into an onTouchMove prop; it will look
 *     tidier and silently stop working.
 *  3. Containment must not depend on pointer capture. Capture is set on the
 *     marker under the finger, and React can unmount that marker mid-pinch when
 *     clusters merge; see the note in onPointerDown for why it still lives
 *     there and why losing it is survivable.
 *  4. OS edge gestures (Android back-swipe, iOS back-swipe / app switcher) own
 *     the outer ~20-24px of the screen and CANNOT be cancelled from a web page.
 *     The only defence is to keep the interactive surface away from the edge —
 *     see `.map-surface { margin-inline }` in index.css.
 *
 * All suppression is scoped to this element and to the duration of an actual
 * touch on it, so pinch-zooming the results table or any text elsewhere in the
 * app still works. Never make it global or session-long.
 */

const MIN_SCALE = 1;
const MAX_SCALE = 8;
/** Screen pixels below which two markers are merged into a cluster. */
const CLUSTER_SEPARATION = 34;
const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 700;
/** Two taps closer together than this, in milliseconds, count as a double tap. */
const DOUBLE_TAP_MS = 300;
/** ...and no further apart than this, in screen pixels. */
const DOUBLE_TAP_SLOP = 32;

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
  /** The wrapper the native, non-passive listeners are attached to. */
  const surface = useRef<HTMLDivElement | null>(null);
  /** True only while at least one finger is down on the map. */
  const touchingMap = useRef(false);
  /** Last single-finger tap, for double-tap-to-zoom. */
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);
  /**
   * Current scale, readable from native listeners. Those listeners are bound
   * once (see the useEffect) so they close over the first render's `scale`;
   * a ref is how they see the live value without rebinding on every zoom.
   */
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

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
    const points = ports.map((port) => ({
      id: port.id,
      port,
      ...project(port),
    }));
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

  /**
   * Native listeners the gesture containment depends on.
   *
   * Bound once, to the wrapper div, and every one of them is removed on
   * unmount. They must be native because React registers touch listeners
   * passively; see the note at the top of this file.
   */
  const zoomToRef = useRef(zoomTo);
  zoomToRef.current = zoomTo;

  useEffect(() => {
    const node = surface.current;
    if (!node) return;

    // These are Safari-only, non-standard events, so they are not in the DOM
    // type definitions. Going through EventTarget keeps the strings legal
    // without an `any`.
    const element = node as EventTarget;
    const doc = document as EventTarget;

    /** Safari's own pinch, expressed as a multiplier since gesturestart. */
    let gestureScale = 1;

    const onGestureStart = (event: Event) => {
      // Cancels Safari's page zoom. Without this line the pinch escapes the
      // page and zooms the whole document, which is the reported bug.
      if (event.cancelable) event.preventDefault();
      gestureScale = 1;
    };

    const onGestureChange = (event: Event) => {
      if (event.cancelable) event.preventDefault();
      // Desktop Safari trackpad pinch arrives here with no touch events at
      // all, so drive the map's own zoom from it rather than just swallowing
      // the gesture and leaving the user with nothing.
      const next = (event as Event & { scale?: number }).scale;
      if (typeof next !== "number" || next <= 0) return;
      const step = next / gestureScale;
      gestureScale = next;
      if (!touchingMap.current) zoomToRef.current(scaleRef.current * step);
    };

    const onGestureEnd = (event: Event) => {
      if (event.cancelable) event.preventDefault();
      gestureScale = 1;
    };

    const onTouchStart = () => {
      touchingMap.current = true;
    };

    const onTouchMove = (event: Event) => {
      // touch-action already covers compliant browsers; this is the belt to
      // that braces, and the only thing that works on older iOS. Guarding on
      // cancelable avoids the console warning when the browser has already
      // decided the gesture is a page scroll.
      if (event.cancelable) event.preventDefault();
    };

    // Cleared from the document rather than the map: if the last finger lifts
    // outside the map (or the gesture is cancelled by a call, a notification,
    // the app switcher) the map's own touchend may never fire, and a stuck
    // flag would leave page zoom suppressed for the rest of the session.
    const onTouchRelease = (event: Event) => {
      const touches = (event as TouchEvent).touches;
      if (!touches || touches.length === 0) touchingMap.current = false;
    };

    const onWheel = (event: WheelEvent) => {
      // ctrlKey on a wheel event is how Chrome/Edge report a trackpad pinch.
      // A plain wheel is left alone so the page still scrolls under the mouse.
      if (!event.ctrlKey) return;
      event.preventDefault();
      zoomToRef.current(
        scaleRef.current * (event.deltaY < 0 ? 1.12 : 1 / 1.12),
      );
    };

    // A long press on an SVG shape opens the iOS callout / Android context
    // menu and cancels the drag underneath it.
    const onContextMenu = (event: Event) => event.preventDefault();

    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    element.addEventListener("gesturestart", onGestureStart, {
      passive: false,
    });
    element.addEventListener("gesturechange", onGestureChange, {
      passive: false,
    });
    element.addEventListener("gestureend", onGestureEnd, { passive: false });
    element.addEventListener("wheel", onWheel as EventListener, {
      passive: false,
    });
    element.addEventListener("contextmenu", onContextMenu);

    // Safari targets gesture events at whatever is under the fingers, which
    // during a two-finger pinch can be an ancestor of the map rather than the
    // map. Capturing at the document catches those — but only while a finger
    // is actually on the map, so pinch-to-zoom on the rest of the app is
    // untouched.
    const onDocumentGesture = (event: Event) => {
      if (touchingMap.current && event.cancelable) event.preventDefault();
    };
    doc.addEventListener("gesturestart", onDocumentGesture, {
      passive: false,
      capture: true,
    });
    doc.addEventListener("gesturechange", onDocumentGesture, {
      passive: false,
      capture: true,
    });
    doc.addEventListener("gestureend", onDocumentGesture, {
      passive: false,
      capture: true,
    });
    doc.addEventListener("touchend", onTouchRelease, {
      passive: true,
      capture: true,
    });
    doc.addEventListener("touchcancel", onTouchRelease, {
      passive: true,
      capture: true,
    });

    return () => {
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("gesturestart", onGestureStart);
      element.removeEventListener("gesturechange", onGestureChange);
      element.removeEventListener("gestureend", onGestureEnd);
      element.removeEventListener("wheel", onWheel as EventListener);
      element.removeEventListener("contextmenu", onContextMenu);
      doc.removeEventListener("gesturestart", onDocumentGesture, {
        capture: true,
      });
      doc.removeEventListener("gesturechange", onDocumentGesture, {
        capture: true,
      });
      doc.removeEventListener("gestureend", onDocumentGesture, {
        capture: true,
      });
      doc.removeEventListener("touchend", onTouchRelease, { capture: true });
      doc.removeEventListener("touchcancel", onTouchRelease, { capture: true });
      touchingMap.current = false;
    };
  }, []);

  function onPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    // Capture stays on the pointerdown target rather than moving to the <svg>.
    // Pointer Events L3 retargets the follow-up `click` to the capture element,
    // so capturing on the <svg> would stop marker taps from ever reaching the
    // per-marker onClick handlers — tap-to-select would quietly die.
    //
    // The known weakness of capturing on a marker is that clusters merge and
    // split as the scale changes, so React can unmount the captured node
    // mid-pinch. That degrades gracefully: pointer events then go to whatever
    // is under the finger, which is still inside this <svg>, and these handlers
    // are on the <svg> so they keep receiving them by bubbling. Containment
    // does not depend on the capture — it depends on the listeners above.
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
    setOffset((offsetNow) =>
      clampOffset({ x: offsetNow.x + dx, y: offsetNow.y + dy }, scale),
    );
  }

  function onPointerUp(event: React.PointerEvent<SVGSVGElement>) {
    const wasDragged = dragged.current;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinchDistance.current = null;

    // Double tap zooms in. It is the one-finger alternative to pinching, which
    // matters both for anyone who cannot pinch and as a fallback if a device
    // still leaks the two-finger gesture to the OS. The +/− buttons remain the
    // gesture-free path and are unaffected by any of this.
    if (
      event.pointerType === "mouse" ||
      wasDragged ||
      pointers.current.size > 0
    ) {
      lastTap.current = null;
      return;
    }
    const previous = lastTap.current;
    const at = Date.now();
    if (
      previous &&
      at - previous.at < DOUBLE_TAP_MS &&
      Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <
        DOUBLE_TAP_SLOP
    ) {
      lastTap.current = null;
      // At full zoom the second double tap goes back out, so one finger can
      // reach every zoom level without ever touching the buttons.
      zoomTo(scale >= MAX_SCALE ? MIN_SCALE : scale * 2);
      return;
    }
    lastTap.current = { at, x: event.clientX, y: event.clientY };
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
          Drag to pan. Double tap, pinch, or use the buttons to zoom. Tap a
          marker to pick it.
        </p>
        <div className="flex gap-2">
          <Button
            onClick={() => zoomTo(scale * 1.5)}
            ariaLabel="Zoom in"
            className="px-3"
          >
            +
          </Button>
          <Button
            onClick={() => zoomTo(scale / 1.5)}
            ariaLabel="Zoom out"
            className="px-3"
          >
            −
          </Button>
          <Button onClick={reset} className="px-3">
            Reset
          </Button>
        </div>
      </div>

      {/*
        The wrapper exists so the native, non-passive listeners have a plain
        HTML element to bind to (Safari has been unreliable about touch-action
        and listener behaviour on SVG nodes), and so `.map-surface` can inset
        the touch area from the screen edges where the OS claims the gesture.
      */}
      <div ref={surface} className="map-surface">
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
            <pattern
              id="sea"
              width="40"
              height="40"
              patternUnits="userSpaceOnUse"
            >
              <path
                d="M0 20 Q10 14 20 20 T40 20"
                fill="none"
                stroke="#1e293b"
                strokeWidth="1"
              />
            </pattern>
          </defs>
          <rect width={VIEW_WIDTH} height={VIEW_HEIGHT} fill="#020617" />
          <rect
            width={VIEW_WIDTH}
            height={VIEW_HEIGHT}
            fill="url(#sea)"
            opacity="0.7"
          />

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
              const availability = portAvailability(
                port,
                state,
                shipRate,
                otherPortId,
              );
              const band = freshnessFor(
                observations.get(port.id) ?? null,
                now,
                thresholds,
              );
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
                    stroke={isSelected ? "#fbbf24" : "#0f172a"}
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
      </div>

      <div className="mt-3 min-h-24 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
        {selected && selectedAvailability ? (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium text-slate-100">
                {portLabel(selected)}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                {
                  freshnessFor(
                    observations.get(selected.id) ?? null,
                    now,
                    thresholds,
                  ).icon
                }{" "}
                {
                  freshnessFor(
                    observations.get(selected.id) ?? null,
                    now,
                    thresholds,
                  ).label
                }
                {selectedState?.controllingFaction
                  ? ` · held by ${selectedState.controllingFaction}`
                  : ""}
              </p>
              {selectedAvailability.message ? (
                <p className="mt-1 text-sm text-amber-200/90">
                  {selectedAvailability.message}
                </p>
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
            Tap a marker to see the port, then confirm it. Markers show data
            freshness; a numbered circle means several ports are too close
            together to tap apart — zoom in.
          </p>
        )}
      </div>

      <MapLegend />
    </div>
  );
}

function MapLegend() {
  const entries = [
    { level: "fresh", icon: "✓", label: "Fresh, under 1 hour" },
    { level: "aging", icon: "◷", label: "Aging, 1–6 hours" },
    { level: "stale", icon: "⚠", label: "Stale, 6–24 hours" },
    { level: "wrong", icon: "!", label: "Likely wrong, over a day" },
    { level: "none", icon: "○", label: "Never recorded" },
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
