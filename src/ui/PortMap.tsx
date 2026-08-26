import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Port, PortState } from "../domain/types";
import { clusterPoints } from "./cluster";
import {
  FRESHNESS_CLASS,
  freshnessFor,
  type FreshnessThresholds,
} from "./freshness";
import { portAvailability, portLabel, projectPorts } from "./ports";
import { Button } from "./Ui";

/**
 * The map, as a full-screen port selector (SPEC 6.2).
 *
 * It opens as a layer over the whole viewport rather than sitting in the page
 * column. That is not decoration. Rendered inline, the map got roughly
 * 358x251 CSS pixels on a phone, and a first attempt drew 42 markers into it
 * at five pixels across — against a 44px minimum tap target. Full screen is
 * about 2.8x the drawing area, and that is what makes real tap targets,
 * always-visible port names and working clustering fit at all.
 *
 * GEOMETRY — the part that was wrong before, and why it is done this way now.
 *
 * The viewBox is measured in CSS pixels and matches the element's real size,
 * so one SVG unit is one screen pixel. Pan and zoom are then applied in
 * JavaScript when positioning each marker, NOT by an SVG group transform.
 * Three bugs die with that change:
 *
 *  1. Panning tracks the finger exactly. Previously a delta measured in CSS
 *     pixels was added to an offset consumed as SVG units, so the map moved at
 *     0.36x the finger when zoomed out and 2.9x when zoomed in. It never felt
 *     right at any zoom because the two units only agreed at desktop width.
 *  2. Markers keep a constant, tappable size at every zoom. Under a scaled
 *     group, a radius has to be divided by the scale to look constant — which
 *     is what the old code did, and it meant zooming in never enlarged a
 *     marker. Pinching to make something tappable is the first thing anyone
 *     tries on a phone, and it was specifically defeated.
 *  3. Clustering fires. The threshold is a real screen distance now. The old
 *     34-unit threshold was below the closest pair of actual ports (54.6
 *     units apart), so no cluster was ever drawn on real data and the hint
 *     telling users about numbered circles described something that could not
 *     happen.
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
 *     nothing. Cancelling a touch requires a NATIVE listener added with
 *     { passive: false } via a ref. Do not move this back into an onTouchMove
 *     prop; it will look tidier and silently stop working.
 *  3. Containment must not depend on pointer capture, which React can tear out
 *     from under a pinch when clusters merge.
 *  4. OS edge gestures (Android back-swipe, iOS back-swipe / app switcher) own
 *     the outer ~20-24px of the screen and CANNOT be cancelled from a web
 *     page. The only defence is to keep the interactive surface away from the
 *     edge — hence the inset on the map area below.
 *
 * All suppression is scoped to this element and to the duration of an actual
 * touch on it, so pinch-zooming the results table or any text elsewhere in the
 * app still works. Never make it global or session-long.
 */

const MIN_SCALE = 1;
const MAX_SCALE = 8;
/** Visible marker radius, in screen pixels, constant at every zoom. */
const MARKER_RADIUS = 9;
/** Invisible hit target radius: 22px gives the 44px minimum tap target. */
const HIT_RADIUS = 22;
/**
 * Screen pixels below which two markers merge into one cluster. Slightly wider
 * than a tap target, so two markers never sit close enough to be ambiguous.
 */
const CLUSTER_SEPARATION = 46;
/** Two taps closer together than this, in milliseconds, count as a double tap. */
const DOUBLE_TAP_MS = 300;
/** ...and no further apart than this, in screen pixels. */
const DOUBLE_TAP_SLOP = 32;
/**
 * How far past the edge the map may be dragged before it stops, as a fraction
 * of the viewport. A little slack stops the pan feeling like it hit a wall.
 */
/**
 * How close to an edge a port must be before its label anchors inward rather
 * than centring. Roughly half the width of a long port name.
 */
const LABEL_EDGE_PAD = 60;
/** Fallback size before the first measurement lands. */
const FALLBACK_SIZE = { width: 360, height: 480 };

/**
 * Clamp one axis so the map never shows a gap at the edge.
 *
 *  - When the content is LARGER than the viewport, the viewport must stay
 *    inside it: pan until an edge meets an edge and no further. Letting it go
 *    further is what put the user on a screen of blank sea at 4x with nothing
 *    to navigate by.
 *  - When the content is SMALLER, there is nothing to pan through, so it is
 *    locked centred. Without this the map could be dragged sideways at 1x and
 *    simply stay there, stranding 31 of the 42 ports off screen with no
 *    spring-back — this map has no inertia or animation to bring them home.
 */
function clampAxis(
  offset: number,
  contentMin: number,
  contentMax: number,
  viewport: number,
): number {
  const span = contentMax - contentMin;
  if (span <= viewport) {
    // Smaller than the screen: it may slide within the slack, but never far
    // enough for any of it to leave. Locking it dead centre instead was worse
    // than it sounds — a locked axis silently overrides the pinch anchor, and
    // the port under the fingers drifted 53px because it could not follow
    // them vertically.
    return Math.max(-contentMin, Math.min(viewport - contentMax, offset));
  }
  // Larger than the screen: the screen must stay inside it, so panning stops
  // when an edge meets an edge. Going further shows blank sea with nothing to
  // navigate by.
  return Math.max(viewport - contentMax, Math.min(-contentMin, offset));
}

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
  onClose,
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
  onClose: () => void;
  now: number;
  thresholds?: FreshnessThresholds;
  stepLabel: string;
}) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [selected, setSelected] = useState<Port | null>(null);
  const [size, setSize] = useState(FALLBACK_SIZE);

  const pointers = useRef(new Map<number, Pointer>());
  const pinchDistance = useRef<number | null>(null);
  const dragged = useRef(false);
  /** The wrapper the native, non-passive listeners are attached to. */
  const surface = useRef<HTMLDivElement | null>(null);
  /** True only while at least one finger is down on the map. */
  const touchingMap = useRef(false);
  /** Last single-finger tap, for double-tap-to-zoom. */
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  /** The live offset, readable synchronously from inside a gesture. */
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  /**
   * Everything a pinch needs, captured once when the second finger lands.
   *
   * A pinch MUST be computed from its own starting point rather than stepped
   * from the previous move. React batches state updates, so a burst of
   * pointermove events all read the same stale `scale` out of the render
   * closure and each one recomputes from it — the increments are lost, and
   * the gesture both under-zooms and drags the anchor away. Measured: fingers
   * asking for x2.53 produced x1.64, and the port under the fingers drifted
   * 265px. Absolute maths from these captured values cannot drift.
   */
  const pinchStart = useRef<{
    distance: number;
    scale: number;
    /** The content point under the fingers when the pinch began. */
    anchorX: number;
    anchorY: number;
  } | null>(null);

  /**
   * Measure the map area so the viewBox can match it in CSS pixels.
   *
   * useLayoutEffect rather than useEffect: this runs before paint, so the map
   * is never briefly drawn at the fallback size and then jumped to the real
   * one.
   */
  useLayoutEffect(() => {
    const node = surface.current;
    if (!node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setSize({ width: rect.width, height: rect.height });
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      // Older browsers, and the server-side render in the smoke tests.
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /**
   * Unzoomed positions in CSS pixels. Extracted to ports.ts so the geometry
   * can be tested without rendering: the bug this replaced (a clustering
   * threshold that never fired on real data) was invisible to every test
   * because it lived inside a component.
   */
  const basePositions = useMemo(
    () => projectPorts(ports, size.width, size.height),
    [ports, size],
  );

  /** Where each port actually lands on screen, after zoom and pan. */
  const screenPositions = useMemo(
    () =>
      basePositions.map((point) => ({
        ...point,
        x: point.x * scale + offset.x,
        y: point.y * scale + offset.y,
      })),
    [basePositions, scale, offset],
  );

  // Clustered in real screen pixels, so the threshold means what it says and
  // markers separate as the user zooms in.
  const clusters = useMemo(
    () => clusterPoints(screenPositions, CLUSTER_SEPARATION),
    [screenPositions],
  );

  /**
   * The ports' own bounding box, in unzoomed pixels.
   *
   * Deliberately NOT the full canvas: fitting a wide map into a tall phone
   * letterboxes it, so the canvas has empty bands the ports never occupy.
   * Clamping against the canvas let the user pan into one of those bands and
   * sit looking at blank sea with no way to tell which way was back.
   */
  const contentBounds = useMemo(() => {
    if (basePositions.length === 0) {
      return { minX: 0, minY: 0, maxX: size.width, maxY: size.height };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of basePositions) {
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
    return { minX, minY, maxX, maxY };
  }, [basePositions, size]);

  /**
   * Keep the map reachable without letting it be dragged into empty space.
   *
   * Clamping is per axis, against the ports' own bounding box rather than the
   * canvas: fitting a wide map into a tall phone letterboxes it, and the empty
   * bands are not somewhere anyone should be able to get lost in. See
   * clampAxis for the two cases.
   *
   * The first version clamped as though the map grew outward from the centre
   * when it grows right and down from the origin, which allowed only half the
   * travel needed and made the map look cut off as soon as you zoomed. The
   * reachability checks in scripts/touch-test.mjs exist because of that.
   */
  function clampOffset(next: { x: number; y: number }, atScale: number) {
    const { minX, minY, maxX, maxY } = contentBounds;
    return {
      x: clampAxis(next.x, minX * atScale, maxX * atScale, size.width),
      y: clampAxis(next.y, minY * atScale, maxY * atScale, size.height),
    };
  }

  /**
   * Zoom about a point on screen, so what is under the fingers stays there.
   * Zooming about the centre — the old behaviour — slides the port you are
   * aiming at away from you, which is the opposite of what a pinch means.
   */
  function zoomTo(nextScale: number, focal?: { x: number; y: number }) {
    const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScale));
    const anchor = focal ?? { x: size.width / 2, y: size.height / 2 };
    // Both the ratio and the new offset are derived from the scale this zoom
    // is actually leaving, captured once. Reading scaleRef inside the updater
    // could observe a value from a different render than the one `clamped`
    // was computed against, which is how a burst of pinch events used to
    // compound off stale numbers.
    const from = scaleRef.current;
    const ratio = clamped / from;
    setOffset((current) =>
      clampOffset(
        {
          x: anchor.x - (anchor.x - current.x) * ratio,
          y: anchor.y - (anchor.y - current.y) * ratio,
        },
        clamped,
      ),
    );
    scaleRef.current = clamped;
    setScale(clamped);
  }

  const zoomToRef = useRef(zoomTo);
  zoomToRef.current = zoomTo;

  /**
   * Re-clamp the view whenever the viewport changes shape.
   *
   * Rotating to landscape re-fits the map, which moves every port and changes
   * what a legal offset is — but the offset itself survives the rotation. A
   * position that was legal in portrait can be far outside the new bounds, and
   * the result was a completely blank map: measured at scale 4, five ports
   * visible in portrait became zero after rotating, with the offset 218px past
   * the legal floor. Nothing recovered it except a manual reset.
   */
  useEffect(() => {
    setOffset((current) => {
      const legal = clampOffset(current, scaleRef.current);
      if (legal.x === current.x && legal.y === current.y) return current;
      offsetRef.current = legal;
      return legal;
    });
    // clampOffset closes over the freshly measured size and content bounds, so
    // re-running on a size change is exactly the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, contentBounds]);

  /** Screen coordinates relative to the map area. */
  function localPoint(clientX: number, clientY: number) {
    const rect = surface.current?.getBoundingClientRect();
    if (!rect) return { x: clientX, y: clientY };
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  /** Escape closes the layer, matching every other modal a user has met. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    // The page behind must not scroll while a full-screen layer is open.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  /**
   * Native listeners the gesture containment depends on.
   *
   * Bound once, to the wrapper div, and every one of them is removed on
   * unmount. They must be native because React registers touch listeners
   * passively; see the note at the top of this file.
   */
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
      if (touches && touches.length > 0) return;
      touchingMap.current = false;
      // Forget every tracked pointer once the screen is genuinely clear.
      //
      // pointerup does not always arrive for every finger — a gesture ended by
      // an incoming call, a notification, or the app switcher can simply stop
      // reporting. A pointer left in the map means the next single-finger drag
      // still looks like a two-finger pinch, so the map stops panning
      // altogether and only a reload fixes it. The touch list is the
      // authority on what is actually down.
      pointers.current.clear();
      pinchDistance.current = null;
      pinchStart.current = null;
    };

    const onWheel = (event: WheelEvent) => {
      // ctrlKey on a wheel event is how Chrome/Edge report a trackpad pinch.
      // A plain wheel is left alone so the page still scrolls under the mouse.
      if (!event.ctrlKey) return;
      event.preventDefault();
      zoomToRef.current(scaleRef.current * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
    };

    // A long press on an SVG shape opens the iOS callout / Android context
    // menu and cancels the drag underneath it.
    const onContextMenu = (event: Event) => event.preventDefault();

    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    element.addEventListener("gesturestart", onGestureStart, { passive: false });
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
    // so capturing on the <svg> would stop marker taps from reaching the
    // per-marker handlers — tap-to-select would quietly die.
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
      const midpoint = localPoint((a!.x + b!.x) / 2, (a!.y + b!.y) / 2);

      if (pinchStart.current === null) {
        if (distance <= 0) return;
        const from = scaleRef.current;
        pinchStart.current = {
          distance,
          scale: from,
          // The content coordinate the fingers grabbed. Holding THIS still is
          // what makes a pinch feel like it is moving the map rather than
          // something happening to the map.
          anchorX: (midpoint.x - offsetRef.current.x) / from,
          anchorY: (midpoint.y - offsetRef.current.y) / from,
        };
        dragged.current = true;
        return;
      }

      const start = pinchStart.current;
      const target = Math.max(
        MIN_SCALE,
        Math.min(MAX_SCALE, start.scale * (distance / start.distance)),
      );
      // Put the grabbed content point back under the fingers wherever they
      // now are, so the pinch pans as well as zooms.
      const next = clampOffset(
        { x: midpoint.x - start.anchorX * target, y: midpoint.y - start.anchorY * target },
        target,
      );
      scaleRef.current = target;
      offsetRef.current = next;
      setScale(target);
      setOffset(next);
      dragged.current = true;
      return;
    }

    // One CSS pixel of finger movement is one pixel of map movement, because
    // the viewBox is measured in CSS pixels and the offset is applied in the
    // same units. This is the whole fix for panning that did not track.
    const dx = current.x - previous.x;
    const dy = current.y - previous.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragged.current = true;
    // scaleRef, not the closure's `scale`: clamping a drag against a scale
    // from an earlier render silently truncates the movement, which is how a
    // finger travelling 72px moved the map only 24px straight after a pinch.
    const live = scaleRef.current;
    const next = clampOffset(
      { x: offsetRef.current.x + dx, y: offsetRef.current.y + dy },
      live,
    );
    offsetRef.current = next;
    setOffset(next);
  }

  function onPointerUp(event: React.PointerEvent<SVGSVGElement>) {
    const wasDragged = dragged.current;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) {
      pinchDistance.current = null;
      // Drop the pinch anchor so the finger still down resumes a clean pan,
      // and so a second pinch re-anchors instead of reusing a dead one.
      pinchStart.current = null;
    }

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
      zoomTo(
        scale >= MAX_SCALE ? MIN_SCALE : scale * 2,
        localPoint(event.clientX, event.clientY),
      );
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
  const selectedBand = selected
    ? freshnessFor(observations.get(selected.id) ?? null, now, thresholds)
    : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Choose a port on the map. ${stepLabel}.`}
      className="fixed inset-0 z-50 flex flex-col bg-slate-950"
      style={{ height: "100dvh" }}
    >
      <header className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-slate-100">
            {stepLabel}
          </h2>
          <p className="text-xs text-slate-500">
            Tap a port, then confirm. {ports.length} ports.
          </p>
        </div>
        <Button onClick={onClose} ariaLabel="Close the map">
          ✕
        </Button>
      </header>

      {/*
        The interactive surface is inset from the screen edges on purpose: the
        outer 20-24px belong to iOS and Android for back-swipe and app
        switching, and a web page cannot take them back. A drag that starts
        inside this box starts outside the strip the OS has reserved.
      */}
      <div ref={surface} className="map-surface relative min-h-0 flex-1">
        <svg
          viewBox={`0 0 ${size.width} ${size.height}`}
          role="group"
          aria-label="Ports plotted at their map coordinates"
          className="h-full w-full touch-none select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <defs>
            <pattern id="sea" width="40" height="40" patternUnits="userSpaceOnUse">
              <path
                d="M0 20 Q10 14 20 20 T40 20"
                fill="none"
                stroke="#1e293b"
                strokeWidth="1"
              />
            </pattern>
          </defs>
          <rect width={size.width} height={size.height} fill="#020617" />
          <rect
            width={size.width}
            height={size.height}
            fill="url(#sea)"
            opacity="0.7"
          />

          {clusters.map((cluster) => {
            if (cluster.members.length > 1) {
              return (
                <g
                  key={cluster.id}
                  onClick={() => {
                    if (dragged.current) return;
                    zoomTo(scale * 2, { x: cluster.x, y: cluster.y });
                  }}
                  className="cursor-zoom-in"
                  aria-label={`${cluster.members.length} ports close together. Zoom in to separate them.`}
                >
                  <circle
                    cx={cluster.x}
                    cy={cluster.y}
                    r={HIT_RADIUS}
                    fill="transparent"
                  />
                  <circle
                    cx={cluster.x}
                    cy={cluster.y}
                    r={MARKER_RADIUS + 5}
                    fill="#1e293b"
                    stroke="#64748b"
                    strokeWidth={2}
                  />
                  <text
                    x={cluster.x}
                    y={cluster.y + 4}
                    textAnchor="middle"
                    fontSize={12}
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
                {/* The real tap target: 44px across, invisible, always the
                    same size no matter the zoom. The visible dot is smaller
                    for legibility, which is why the two are separate. */}
                <circle cx={x} cy={y} r={HIT_RADIUS} fill="transparent" />
                <circle
                  cx={x}
                  cy={y}
                  r={isSelected ? MARKER_RADIUS + 3 : MARKER_RADIUS}
                  fill={FRESHNESS_CLASS[band.level].svgFill}
                  opacity={availability.selectable ? 1 : 0.35}
                  stroke={isSelected ? "#fbbf24" : "#0f172a"}
                  strokeWidth={isSelected ? 3 : 1.5}
                />
                {/* The icon repeats the band without relying on the colour,
                    and it is legible now because it does not shrink. */}
                <text
                  x={x}
                  y={y + 4}
                  textAnchor="middle"
                  fontSize={11}
                  fill="#0f172a"
                  fontWeight="700"
                  opacity={availability.selectable ? 0.9 : 0.5}
                >
                  {band.icon}
                </text>
                {/*
                  Anchor the label inward near the edges. A centred label on a
                  port close to the left or right edge runs off the viewBox and
                  is silently clipped — "Cursed City" rendered as "ursed City"
                  until a screenshot from the touch harness showed it.
                */}
                <text
                  x={x}
                  y={y + MARKER_RADIUS + 14}
                  textAnchor={
                    x < LABEL_EDGE_PAD
                      ? "start"
                      : x > size.width - LABEL_EDGE_PAD
                        ? "end"
                        : "middle"
                  }
                  fontSize={11}
                  fill={isSelected ? "#fbbf24" : "#cbd5e1"}
                  opacity={availability.selectable ? 1 : 0.5}
                >
                  {portLabel(port)}
                </text>
              </g>
            );
          })}
        </svg>

        {/* Zoom controls sit bottom-right, inside thumb reach, and are the
            path that needs no gesture at all. */}
        <div className="absolute right-3 bottom-3 flex flex-col gap-2">
          <Button
            onClick={() => zoomTo(scale * 1.5)}
            ariaLabel="Zoom in"
            className="w-12 px-0"
          >
            +
          </Button>
          <Button
            onClick={() => zoomTo(scale / 1.5)}
            ariaLabel="Zoom out"
            className="w-12 px-0"
          >
            −
          </Button>
          <Button onClick={reset} ariaLabel="Reset the view" className="w-12 px-0">
            ⟲
          </Button>
        </div>
      </div>

      {/*
        The port card and its confirm button are pinned to the bottom of the
        screen, so the thing you press is always in thumb reach and never
        below a fold. The old inline map put "Choose" roughly 700px down.
      */}
      <div className="border-t border-slate-800 bg-slate-900/80 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {selected && selectedAvailability && selectedBand ? (
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-medium text-slate-100">
                {portLabel(selected)}
              </p>
              <p className="mt-0.5 text-xs text-slate-400">
                <span aria-hidden="true">{selectedBand.icon} </span>
                {selectedBand.label}
                {selectedBand.ageText ? ` · ${selectedBand.ageText}` : ""}
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
              className="flex-1 sm:flex-none"
            >
              Choose {portLabel(selected)}
            </Button>
          </div>
        ) : (
          <p className="py-2 text-sm text-slate-400">
            Tap a port to see it here. A numbered circle means several ports are
            too close to tap apart — tap it to zoom in.
          </p>
        )}
        <MapLegend />
      </div>
    </div>
  );
}

function MapLegend() {
  const entries = [
    { level: "fresh", icon: "✓", label: "Under 1 hour" },
    { level: "aging", icon: "◷", label: "1–6 hours" },
    { level: "stale", icon: "⚠", label: "6–24 hours" },
    { level: "wrong", icon: "!", label: "Over a day" },
    { level: "none", icon: "○", label: "Never recorded" },
  ] as const;
  return (
    <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
      {entries.map((entry) => (
        <li key={entry.level} className="flex items-center gap-1">
          <span
            aria-hidden="true"
            className={`size-2 rounded-full ${FRESHNESS_CLASS[entry.level].dot}`}
          />
          <span aria-hidden="true">{entry.icon}</span>
          <span>{entry.label}</span>
        </li>
      ))}
    </ul>
  );
}
