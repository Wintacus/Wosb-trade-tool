/**
 * Drive the real map with a real browser and real fingers.
 *
 * Why this exists: every one of the map's worst bugs was a touch bug, and
 * touch is exactly what the unit tests cannot reach — they render components
 * to a string, with no browser, no layout and no fingers. Markers five pixels
 * across, panning that tracked at 0.36x, clustering that never fired and
 * labels clipped off the edge all passed 378 tests and were found by a person
 * on a phone. This script closes as much of that gap as a Linux box can.
 *
 * WHAT IT CANNOT DO — read before trusting a green run:
 *
 *   The reported pinch bug is iOS Safari's `gesturestart` / `gesturechange`,
 *   a non-standard WebKit API that NO Chromium build implements, and
 *   Playwright's WebKit cannot be downloaded here (the proxy blocks
 *   playwright.download.prss.microsoft.com). A pass here means the map
 *   behaves under Chromium's touch emulation. It says nothing at all about
 *   Safari page zoom or about OS-level edge gestures, which no browser can
 *   report on and no web page can prevent.
 *
 * Usage (needs a one-off `npm i -D playwright` in the session; deliberately
 * NOT a package.json dependency, because CI has no browser to run it and the
 * install would slow every build for a check CI cannot perform):
 *
 *   node scripts/touch-test.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const PORT = 5199;
const URL = `http://localhost:${PORT}/map-harness.html`;
const CHROME_CANDIDATES = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
];

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('playwright is not installed. Run:  npm i -D playwright');
  process.exit(2);
}

const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.error(`No Chromium found. Looked in:\n  ${CHROME_CANDIDATES.join('\n  ')}`);
  process.exit(2);
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// Spawned directly rather than through npx: npx is a wrapper process, so
// killing it can orphan the vite server it started and leave the port held.
// Killing the child directly is also why this does NOT use a process-group
// kill — a negative pid took out this script along with the server.
const vite = spawn('node_modules/.bin/vite', ['--port', String(PORT), '--strictPort'], {
  stdio: 'ignore',
});
const stopVite = () => {
  try {
    vite.kill('SIGTERM');
  } catch {
    /* already gone */
  }
};

try {
  // Wait for the dev server rather than sleeping a fixed amount.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(URL);
      if (response.ok) break;
    } catch {
      /* not up yet */
    }
    if (attempt > 60) throw new Error('vite did not start');
    await new Promise((r) => setTimeout(r, 500));
  }

  const browser = await chromium.launch({ executablePath });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  /**
   * Every check starts from a freshly loaded map.
   *
   * Learned the hard way: the pan and pinch checks leave the map dragged and
   * zoomed, so the checks after them were asserting against a moved map and
   * reporting failures that were entirely the test's own doing. A port panned
   * off screen has its label outside the viewBox quite legitimately.
   */
  const reset = async () => {
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('svg circle[r="22"]');
  };
  await reset();

  // Tap targets. The original markers were 5px across; 22px radius is 44px.
  const hits = await page.$$eval('svg circle[r="22"]', (els) => els.length);
  check('every marker has a 44px tap target', hits > 0, `${hits} markers`);

  // Panning must track the finger exactly. It used to move at 0.36x-2.9x
  // because a CSS-pixel delta was applied as an SVG unit.
  //
  // Measured while ZOOMED IN, deliberately. At scale 1 the whole map already
  // fits the screen, so there is nowhere to pan to and the clamp correctly
  // refuses to move it — asserting 1:1 tracking there tests the clamp, not
  // the tracking.
  await reset();
  for (let i = 0; i < 3; i += 1) {
    await page.click('button[aria-label="Zoom in"]');
    await page.waitForTimeout(120);
  }
  const xs = () =>
    page.$$eval('svg circle[r="22"]', (els) =>
      els.slice(0, 3).map((e) => Number(e.getAttribute('cx'))),
    );
  const before = await xs();
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 200, y: 400, id: 1 }],
  });
  for (let i = 1; i <= 6; i += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: 200 + i * 10, y: 400, id: 1 }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(150);
  const after = await xs();
  const moved = after.map((x, i) => x - before[i]);
  const tracks = moved.every((m) => Math.abs(m - 60) < 3);
  check('panning tracks the finger 1:1', tracks, `finger +60px, map ${moved.map(Math.round).join('/')}px`);

  // Pinch must zoom the MAP and leave the PAGE alone.
  await reset();
  const span = () =>
    page.evaluate(() => {
      const cx = [...document.querySelectorAll('svg circle[r="22"]')].map((e) =>
        Number(e.getAttribute('cx')),
      );
      return Math.max(...cx) - Math.min(...cx);
    });
  const spanBefore = await span();
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: 150, y: 400, id: 1 },
      { x: 250, y: 400, id: 2 },
    ],
  });
  for (let i = 1; i <= 8; i += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: 150 - i * 8, y: 400, id: 1 },
        { x: 250 + i * 8, y: 400, id: 2 },
      ],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(200);
  const ratio = (await span()) / spanBefore;
  check('a two-finger pinch zooms the map', ratio > 1.1, `spread x${ratio.toFixed(2)}`);
  const pageScale = await page.evaluate(() => visualViewport.scale);
  check('the pinch does not zoom the page (Chromium only)', pageScale === 1, `visualViewport.scale ${pageScale}`);

  // Zoomed in, every edge of the map must still be reachable by panning.
  // This is the bug a user hit: the clamp allowed only half the travel the
  // overflow needed, so the right and bottom of the map were cut off and
  // could not be panned to. It got worse the further you zoomed.
  await reset();
  for (let i = 0; i < 4; i += 1) {
    await page.click('button[aria-label="Zoom in"]');
    await page.waitForTimeout(120);
  }
  // The map does not fill the screen: a header sits above it and the port
  // card below. A drag starting at a guessed y can land on the card and do
  // nothing, which reads as a failure of the map.
  const surface = await page.$('.map-surface');
  const area = await surface.boundingBox();
  const dragTo = async (fromX, fromY, toX, toY) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fromX, y: fromY, id: 1 }] });
    for (let i = 1; i <= 8; i += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: fromX + ((toX - fromX) * i) / 8, y: fromY + ((toY - fromY) * i) / 8, id: 1 }],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(60);
  };
  const midY = area.y + area.height / 2;
  for (let d = 0; d < 12; d += 1) {
    await dragTo(area.x + area.width - 40, midY, area.x + 40, midY);
  }
  const right = await page.evaluate(() => {
    const cx = [...document.querySelectorAll('svg circle[r="22"]')].map((e) => Number(e.getAttribute('cx')));
    return { max: Math.max(...cx), width: document.querySelector('svg').viewBox.baseVal.width };
  });
  check(
    'the right edge of the map is reachable when zoomed in',
    right.max <= right.width + 5,
    right.max <= right.width + 5 ? '' : `rightmost port ${Math.round(right.max - right.width)}px past the edge`,
  );

  const midX = area.x + area.width / 2;
  for (let d = 0; d < 12; d += 1) {
    await dragTo(midX, area.y + area.height - 40, midX, area.y + 40);
  }
  const bottom = await page.evaluate(() => {
    const cy = [...document.querySelectorAll('svg circle[r="22"]')].map((e) => Number(e.getAttribute('cy')));
    return { max: Math.max(...cy), height: document.querySelector('svg').viewBox.baseVal.height };
  });
  check(
    'the bottom edge of the map is reachable when zoomed in',
    bottom.max <= bottom.height + 5,
    bottom.max <= bottom.height + 5 ? '' : `lowest port ${Math.round(bottom.max - bottom.height)}px past the edge`,
  );

  // No label may run off the viewBox: "Cursed City" rendered as "ursed City".
  await reset();
  const clipped = await page.evaluate(() => {
    const width = document.querySelector('svg').viewBox.baseVal.width;
    return [...document.querySelectorAll('svg text')]
      .filter((t) => {
        const box = t.getBBox();
        return box.x < -0.5 || box.x + box.width > width + 0.5;
      })
      .map((t) => t.textContent);
  });
  check('no port label is clipped at the edge', clipped.length === 0, clipped.join(', '));

  // Tapping a single port selects it; tapping a cluster zooms in.
  await reset();
  const single = await page.evaluateHandle(() =>
    [...document.querySelectorAll('svg g[aria-label]')]
      .find((g) => !g.getAttribute('aria-label').includes('close together'))
      ?.querySelector('circle[r="22"]'),
  );
  const box = await single.asElement()?.boundingBox();
  if (box) {
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(250);
  }
  const choose = await page.$$eval('button', (b) =>
    b.map((x) => x.textContent).filter((t) => t.startsWith('Choose')),
  );
  check('tapping a port offers a confirm button', choose.length > 0, choose[0] ?? 'none');

  await reset();
  const markersBefore = await page.$$eval('svg circle[r="22"]', (e) => e.length);
  const cluster = await page.evaluateHandle(() =>
    [...document.querySelectorAll('svg g[aria-label]')]
      .find((g) => g.getAttribute('aria-label').includes('close together'))
      ?.querySelector('circle[r="22"]'),
  );
  const clusterBox = await cluster.asElement()?.boundingBox();
  if (clusterBox) {
    await page.touchscreen.tap(clusterBox.x + clusterBox.width / 2, clusterBox.y + clusterBox.height / 2);
    await page.waitForTimeout(250);
    const markersAfter = await page.$$eval('svg circle[r="22"]', (e) => e.length);
    check('tapping a cluster zooms in and separates it', markersAfter > markersBefore, `${markersBefore} -> ${markersAfter} markers`);
  } else {
    check('a cluster is drawn at default zoom', false, 'no cluster found — clustering may be dead again');
  }


  // ==================================================================
  // A SECOND PASS, HUNTING ADVERSARIALLY.
  //
  // Every bug this map has shipped was geometry that only misbehaves at a
  // real size, under a real gesture, at a zoom no unit test ever sets. The
  // checks above cover the ones a person already found. The ones below go
  // looking for the rest: reachability at every zoom, the focal point of a
  // pinch, rotation, and the messy input a thumb actually produces.
  //
  // Two rules, both learned the expensive way:
  //   1. reset() before every independent check. An earlier pan otherwise
  //      makes a later check fail for reasons that are the test's fault.
  //   2. Assert on measured screen positions, never on what the code
  //      "ought" to produce. The maths being wrong is the thing we are
  //      looking for, so it cannot also be the yardstick.
  // ==================================================================

  const SHOT_DIR = process.env.MAP_SHOT_DIR ?? '/tmp/map-touch-test';
  mkdirSync(SHOT_DIR, { recursive: true });
  const shoot = (name) => page.screenshot({ path: `${SHOT_DIR}/${name}.png` });

  /**
   * Load the app's own projection into the page.
   *
   * The map draws one marker per CLUSTER, so at low zoom a port has no
   * marker of its own and its position cannot be read out of the DOM at
   * all. Importing ports.ts through the dev server gives the exact base
   * position of all 42 — the app's own maths rather than a copy of it here
   * that could quietly drift away from it.
   */
  const installProbe = () =>
    page.evaluate(async () => {
      const [geometry, mappers, file] = await Promise.all([
        import('/src/ui/ports.ts'),
        import('/src/data/mappers.ts'),
        import('/data/ports.json'),
      ]);
      window.__probe = {
        projectPorts: geometry.projectPorts,
        portLabel: geometry.portLabel,
        ports: (file.default ?? file).ports.map(mappers.toPort),
      };
      return window.__probe.ports.length;
    });

  const freshMap = async () => {
    await reset();
    await installProbe();
  };

  /**
   * The map's state, recovered from what is actually drawn.
   *
   * scale and offset live in React state and are exposed nowhere, so they
   * are solved for instead: take the two furthest-apart single markers,
   * compare where they are drawn with where the projection puts them, and
   * the affine transform falls out. Every port's true screen position
   * follows from it — including ports currently hidden inside a cluster,
   * which is the whole reason for doing it this way.
   */
  const readMap = () =>
    page.evaluate(() => {
      const { projectPorts, portLabel, ports } = window.__probe;
      const svg = document.querySelector('svg');
      const W = svg.viewBox.baseVal.width;
      const H = svg.viewBox.baseVal.height;
      const base = projectPorts(ports, W, H).map((p) => ({
        name: portLabel(p.port),
        x: p.x,
        y: p.y,
      }));
      const byName = new Map(base.map((b) => [b.name, b]));
      const markers = [...document.querySelectorAll('svg g[aria-label]')].map((g) => {
        const label = g.getAttribute('aria-label');
        const hit = g.querySelector('circle[r="22"]');
        return {
          cluster: label.includes('close together'),
          name: label.split(', ')[0],
          x: Number(hit.getAttribute('cx')),
          y: Number(hit.getAttribute('cy')),
        };
      });
      const singles = markers.filter((m) => !m.cluster && byName.has(m.name));
      let scale = null;
      let ox = null;
      let oy = null;
      if (singles.length >= 2) {
        // The widest-apart pair, so the division is never by a small number.
        let best = null;
        for (let i = 0; i < singles.length; i += 1) {
          for (let j = i + 1; j < singles.length; j += 1) {
            const spread = Math.abs(byName.get(singles[i].name).x - byName.get(singles[j].name).x);
            if (!best || spread > best.spread) best = { spread, a: singles[i], b: singles[j] };
          }
        }
        const ba = byName.get(best.a.name);
        const bb = byName.get(best.b.name);
        scale = (best.a.x - best.b.x) / (ba.x - bb.x);
        ox = best.a.x - ba.x * scale;
        oy = best.a.y - ba.y * scale;
      }
      const positions = base.map((b) => ({
        name: b.name,
        baseX: b.x,
        baseY: b.y,
        x: b.x * scale + ox,
        y: b.y * scale + oy,
      }));
      return {
        W,
        H,
        scale,
        ox,
        oy,
        markers,
        positions,
        clusters: markers.filter((m) => m.cluster).length,
        onScreen: positions.filter((p) => p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H).length,
      };
    });

  const mapArea = async () => (await page.$('.map-surface')).boundingBox();
  const inView = (state, port) =>
    port.x >= 0 && port.x <= state.W && port.y >= 0 && port.y <= state.H;
  const extremesOf = (state) => ({
    leftmost: [...state.positions].sort((a, b) => a.baseX - b.baseX)[0],
    rightmost: [...state.positions].sort((a, b) => b.baseX - a.baseX)[0],
    topmost: [...state.positions].sort((a, b) => a.baseY - b.baseY)[0],
    bottommost: [...state.positions].sort((a, b) => b.baseY - a.baseY)[0],
  });

  const tapAt = async (x, y) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  /** Two taps inside DOUBLE_TAP_MS (300ms) and DOUBLE_TAP_SLOP (32px). */
  const doubleTapAt = async (x, y) => {
    await tapAt(x, y);
    await page.waitForTimeout(70);
    await tapAt(x, y);
    await page.waitForTimeout(220);
  };
  /**
   * A point with no marker near it.
   *
   * A double tap that lands on a cluster ALSO fires the cluster's own
   * zoom-to-separate handler, so the map would zoom twice and the test
   * would be measuring its own mistake rather than the double tap.
   */
  const emptySpot = (state, box) => {
    for (let radius = 0; radius <= 160; radius += 20) {
      for (let angle = 0; angle < 360; angle += 30) {
        const x = state.W / 2 + radius * Math.cos((angle * Math.PI) / 180);
        const y = state.H / 2 + radius * Math.sin((angle * Math.PI) / 180);
        if (x < 40 || y < 40 || x > state.W - 40 || y > state.H - 90) continue;
        const clear = state.markers.every((m) => Math.hypot(m.x - x, m.y - y) > 34);
        if (clear) return { x: box.x + x, y: box.y + y };
      }
    }
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  /** Double tap doubles the scale, so n taps give exactly 2^n. */
  const zoomBy = async (times, box) => {
    for (let i = 0; i < times; i += 1) {
      const spot = emptySpot(await readMap(), box);
      await doubleTapAt(spot.x, spot.y);
    }
    return readMap();
  };

  /**
   * Drag toward a port until it is on screen, the way a person does: look
   * at where it is, pull the map that way, look again. Gives up after 14
   * gestures, which is far more than the travel needs at any zoom.
   */
  const panToward = async (name, box) => {
    let state = await readMap();
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const port = state.positions.find((p) => p.name === name);
      if (inView(state, port)) return state;
      const wantX = Math.max(-240, Math.min(240, state.W / 2 - port.x));
      const wantY = Math.max(-360, Math.min(360, state.H / 2 - port.y));
      const fromX = box.x + box.width / 2 - wantX / 2;
      const fromY = box.y + box.height / 2 - wantY / 2;
      await dragTo(fromX, fromY, fromX + wantX, fromY + wantY);
      state = await readMap();
    }
    return state;
  };

  /** Drag the same way repeatedly until the clamp stops the map moving. */
  const panToLimit = async (dx, dy, box) => {
    for (let i = 0; i < 16; i += 1) {
      await dragTo(
        box.x + box.width / 2 - dx / 2,
        box.y + box.height / 2 - dy / 2,
        box.x + box.width / 2 + dx / 2,
        box.y + box.height / 2 + dy / 2,
      );
    }
    return readMap();
  };

  // --- REACHABILITY AT EVERY ZOOM ------------------------------------
  //
  // The bug a user hit, generalised. It is not enough that the right edge
  // is reachable at one zoom: each of the four extreme ports must be
  // draggable into view at every zoom the app offers. Each direction gets
  // a freshly loaded map, because a map already panned to one corner
  // proves nothing about the next.
  for (const wanted of [2, 4, 8]) {
    const unreachable = [];
    let achieved = null;
    for (const which of ['leftmost', 'rightmost', 'topmost', 'bottommost']) {
      await freshMap();
      const box = await mapArea();
      const zoomed = await zoomBy(Math.log2(wanted), box);
      achieved = zoomed.scale;
      const target = extremesOf(zoomed)[which];
      const settled = await panToward(target.name, box);
      const port = settled.positions.find((p) => p.name === target.name);
      // A port is only really reachable if something is drawn for it: at
      // low zoom it may be inside a cluster, which is fine — the cluster
      // is tappable and separates — but it must be on screen either way.
      const drawn = settled.markers.some((m) => Math.hypot(m.x - port.x, m.y - port.y) <= 46);
      if (!inView(settled, port) || !drawn) {
        unreachable.push(
          `${which} ${target.name} at (${Math.round(port.x)},${Math.round(port.y)}) in ${Math.round(settled.W)}x${Math.round(settled.H)}${drawn ? '' : ', nothing drawn for it'}`,
        );
        await shoot(`unreachable-scale${wanted}-${which}`);
      }
    }
    check(
      `every extreme port can be panned into view at scale ${wanted}`,
      unreachable.length === 0,
      unreachable.length === 0 ? `measured scale ${achieved?.toFixed(2)}` : unreachable.join('; '),
    );
  }

  // --- NO PORT ANYWHERE MAY BECOME UNREACHABLE -----------------------
  //
  // Proved for all 42 rather than the four extremes, from the clamp's
  // MEASURED limits: a port is reachable when some legal offset puts it
  // inside the viewport, i.e. when the offsets that would show it overlap
  // the offsets the clamp permits.
  await freshMap();
  {
    const box = await mapArea();
    await zoomBy(3, box);
    const east = await panToLimit(-240, 0, box);
    const west = await panToLimit(240, 0, box);
    const south = await panToLimit(0, -360, box);
    const north = await panToLimit(0, 360, box);
    const scaleNow = north.scale;
    const stranded = north.positions.filter((p) => {
      const needX = [-p.baseX * scaleNow, north.W - p.baseX * scaleNow];
      const needY = [-p.baseY * scaleNow, north.H - p.baseY * scaleNow];
      const okX = needX[1] >= east.ox && needX[0] <= west.ox;
      const okY = needY[1] >= south.oy && needY[0] <= north.oy;
      return !(okX && okY);
    });
    check(
      'no port is unreachable at max zoom',
      stranded.length === 0,
      stranded.length === 0
        ? `all 42 reachable at scale ${scaleNow.toFixed(2)}, pan range x [${Math.round(east.ox)}, ${Math.round(west.ox)}] y [${Math.round(south.oy)}, ${Math.round(north.oy)}]`
        : `${stranded.length} stranded: ${stranded.slice(0, 4).map((p) => p.name).join(', ')}`,
    );
    check(
      'no cluster survives at max zoom',
      north.clusters === 0,
      north.clusters === 0
        ? `${north.markers.length} separate markers at scale ${scaleNow.toFixed(2)}`
        : `${north.clusters} clusters left at max zoom and tapping one cannot zoom further — the user is stuck`,
    );
  }

  // --- ZOOM FOCAL POINT ----------------------------------------------
  //
  // Pinching centred on a marker must keep that marker under the fingers.
  // Tolerance is 20px: the visible marker is 18px across, so anything
  // under that still leaves the port beneath the fingertips, and a correct
  // implementation lands within a pixel or two.
  //
  // Note on the gesture: a browser fires ONE pointermove per pointer, so
  // two fingers moving together arrive as two separate events, and the
  // first of them only establishes the baseline distance. The most a
  // 10-step pinch from 80px to 220px can therefore ask for is 220/87.
  await freshMap();
  {
    const start = await readMap();
    const box = await mapArea();
    const target = [...start.positions]
      .filter((p) => start.markers.some((m) => !m.cluster && m.name === p.name))
      .sort(
        (a, b) =>
          Math.hypot(a.x - start.W / 2, a.y - start.H / 2) -
          Math.hypot(b.x - start.W / 2, b.y - start.H / 2),
      )[0];
    const fx = box.x + target.x;
    const fy = box.y + target.y;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { x: fx - 40, y: fy, id: 1 },
        { x: fx + 40, y: fy, id: 2 },
      ],
    });
    for (let i = 1; i <= 10; i += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: fx - 40 - i * 7, y: fy, id: 1 },
          { x: fx + 40 + i * 7, y: fy, id: 2 },
        ],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(250);
    const after = await readMap();
    const moved = after.positions.find((p) => p.name === target.name);
    const drift = Math.hypot(moved.x - target.x, moved.y - target.y);
    check(
      'a pinch keeps the port under the fingers',
      drift <= 20,
      `${target.name} drifted ${Math.round(drift)}px (tolerance 20px)`,
    );
    const asked = 220 / 87;
    check(
      'a pinch zooms by as much as the fingers ask',
      Math.abs(after.scale - asked) / asked <= 0.12,
      `fingers spread 80px to 220px (x${asked.toFixed(2)}), map scaled x${after.scale.toFixed(2)}`,
    );
    if (drift > 20) await shoot('pinch-focal-drift');
  }

  // --- DOUBLE TAP -----------------------------------------------------
  await freshMap();
  {
    const box = await mapArea();
    const opening = await readMap();
    const spot = emptySpot(opening, box);
    await doubleTapAt(spot.x, spot.y);
    const zoomed = await readMap();
    check(
      'a double tap zooms in',
      zoomed.scale > 1.9 && zoomed.scale < 2.1,
      `scale ${opening.scale.toFixed(2)} -> ${zoomed.scale.toFixed(2)}`,
    );
  }
  await freshMap();
  {
    const box = await mapArea();
    const atMax = await zoomBy(3, box);
    const spot = emptySpot(atMax, box);
    await doubleTapAt(spot.x, spot.y);
    const out = await readMap();
    check(
      'a double tap at max zoom returns to the fitted view',
      out.scale <= 1.01 && out.onScreen === out.positions.length,
      `scale ${atMax.scale.toFixed(2)} -> ${out.scale.toFixed(2)}, ${out.onScreen}/${out.positions.length} ports on screen`,
    );
  }

  // --- ORIENTATION -----------------------------------------------------
  //
  // Rotating changes the measured size, which re-projects every port and
  // changes what the clamp permits. Nothing re-clamps the offset when that
  // happens, so this is exactly where a stale offset would strand the map.
  await freshMap();
  {
    const box = await mapArea();
    const zoomed = await zoomBy(2, box);
    const portraitOn = zoomed.onScreen;
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(500);
    const landscape = await readMap();
    check(
      'rotating to landscape while zoomed in leaves ports on screen',
      landscape.onScreen > 0,
      `${portraitOn} ports visible in portrait at scale ${zoomed.scale.toFixed(2)}, ${landscape.onScreen} after rotating (offset ${Math.round(landscape.ox)},${Math.round(landscape.oy)} against a legal y floor of ${Math.round(landscape.H * (1 - landscape.scale) - landscape.H * 0.08)})`,
    );
    if (landscape.onScreen === 0) await shoot('rotate-landscape-blank');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
  }
  await freshMap();
  {
    let fits = [];
    for (const [w, h, name] of [
      [844, 390, 'landscape'],
      [390, 844, 'portrait'],
    ]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(500);
      const state = await readMap();
      const box = await mapArea();
      const matches =
        Math.abs(state.W - box.width) < 1.5 && Math.abs(state.H - box.height) < 1.5;
      const outside = state.markers.filter(
        (m) => m.x < 0 || m.x > state.W || m.y < 0 || m.y > state.H,
      );
      if (!matches || outside.length > 0) {
        fits.push(
          `${name}: viewBox ${Math.round(state.W)}x${Math.round(state.H)} vs box ${Math.round(box.width)}x${Math.round(box.height)}, ${outside.length} markers outside`,
        );
      }
      await shoot(`orientation-${name}`);
    }
    check(
      'the map re-fits the viewport on rotation, both ways',
      fits.length === 0,
      fits.length === 0 ? 'viewBox tracks the element and nothing is left outside it' : fits.join('; '),
    );
  }

  // --- RESET -----------------------------------------------------------
  await freshMap();
  {
    const box = await mapArea();
    const opening = (await readMap()).positions.map((p) => `${p.name}:${p.x.toFixed(2)},${p.y.toFixed(2)}`).join('|');
    await zoomBy(2, box);
    await dragTo(box.x + 300, box.y + 500, box.x + 80, box.y + 180);
    await page.click('button[aria-label="Reset the view"]');
    await page.waitForTimeout(250);
    const back = (await readMap()).positions.map((p) => `${p.name}:${p.x.toFixed(2)},${p.y.toFixed(2)}`).join('|');
    check(
      'the reset button restores the opening view exactly',
      opening === back,
      opening === back ? 'every port back to the pixel' : 'ports do not return to their opening positions',
    );
  }

  // --- MESSY INPUT ------------------------------------------------------
  //
  // A thumb does not produce the clean gestures above. It drags from on top
  // of a marker, it wobbles during a tap, and it lifts one finger before
  // the other.
  const chooseButtons = () =>
    page.$$eval('button', (buttons) =>
      buttons.map((b) => b.textContent).filter((t) => t.startsWith('Choose')),
    );

  await freshMap();
  {
    const state = await readMap();
    const box = await mapArea();
    const marker = state.markers.find((m) => !m.cluster);
    const startOx = state.ox;
    await dragTo(box.x + marker.x, box.y + marker.y, box.x + marker.x - 90, box.y + marker.y - 40);
    await page.waitForTimeout(250);
    const after = await readMap();
    const picked = await chooseButtons();
    check(
      'a drag that starts on a marker pans without selecting it',
      picked.length === 0 && Math.abs(after.ox - startOx) > 10,
      picked.length === 0
        ? `map moved ${Math.round(after.ox - startOx)}px, nothing selected`
        : `selected ${picked[0]} on release`,
    );
  }

  await freshMap();
  {
    const state = await readMap();
    const box = await mapArea();
    const marker = state.markers.find((m) => !m.cluster);
    // A tap that slips two pixels is still a tap. This is the boundary the
    // drag threshold sits on, and getting it wrong makes the map feel dead.
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: box.x + marker.x, y: box.y + marker.y, id: 1 }],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: box.x + marker.x + 2, y: box.y + marker.y + 1, id: 1 }],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(300);
    const picked = await chooseButtons();
    check(
      'a tap that slips 2px still selects the port',
      picked.length > 0,
      picked[0] ?? `nothing selected after tapping ${marker.name}`,
    );
  }

  await freshMap();
  {
    const box = await mapArea();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    // Pinch with two fingers, lift one, then keep dragging with the other.
    // The remaining finger must pan 1:1 and must not go on zooming.
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { x: cx - 60, y: cy, id: 1 },
        { x: cx + 60, y: cy, id: 2 },
      ],
    });
    for (let i = 1; i <= 6; i += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: cx - 60 - i * 8, y: cy, id: 1 },
          { x: cx + 60 + i * 8, y: cy, id: 2 },
        ],
      });
      await page.waitForTimeout(20);
    }
    // In CDP the points listed on a touchEnd are the ones being RELEASED,
    // so this lifts finger 1 and leaves finger 2 down.
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [{ x: cx - 108, y: cy, id: 1 }],
    });
    await page.waitForTimeout(120);
    const lifted = await readMap();
    for (let i = 1; i <= 6; i += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: cx + 108 - i * 12, y: cy, id: 2 }],
      });
      await page.waitForTimeout(20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(250);
    const ended = await readMap();
    const picked = await chooseButtons();
    const scaleHeld = Math.abs(ended.scale - lifted.scale) / lifted.scale < 0.02;
    const panned = Math.abs(ended.ox - lifted.ox + 72) <= 8;
    check(
      'a pinch where one finger lifts first keeps panning cleanly',
      scaleHeld && panned && picked.length === 0,
      `after the lift: scale ${lifted.scale.toFixed(2)} -> ${ended.scale.toFixed(2)} (must hold), map moved ${Math.round(ended.ox - lifted.ox)}px for a finger that moved -72px${picked.length ? `, and it selected ${picked[0]}` : ''}`,
    );
  }

  // --- THE GESTURE-FREE PATH -------------------------------------------
  //
  // Anyone who cannot pinch, or whose device leaks the gesture to the OS,
  // uses these three buttons. They must stay reachable, stay 44px, and
  // still work at the extremes of zoom.
  await freshMap();
  {
    const box = await mapArea();
    await zoomBy(3, box);
    const buttons = await page.evaluate(() => {
      const out = {};
      for (const label of ['Zoom in', 'Zoom out', 'Reset the view']) {
        const button = document.querySelector(`button[aria-label="${label}"]`);
        const rect = button.getBoundingClientRect();
        const onTop = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        out[label] = {
          size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
          big: rect.width >= 44 && rect.height >= 44,
          covered: !button.contains(onTop),
          inside: rect.bottom <= window.innerHeight && rect.right <= window.innerWidth && rect.top >= 0,
        };
      }
      return out;
    });
    const bad = Object.entries(buttons).filter(
      ([, b]) => !b.big || b.covered || !b.inside,
    );
    await page.click('button[aria-label="Zoom in"]');
    await page.waitForTimeout(150);
    const stillMax = await readMap();
    for (let i = 0; i < 6; i += 1) {
      await page.click('button[aria-label="Zoom out"]');
      await page.waitForTimeout(120);
    }
    const zoomedOut = await readMap();
    const works =
      stillMax.scale <= 8.01 &&
      zoomedOut.scale <= 1.01 &&
      zoomedOut.onScreen === zoomedOut.positions.length;
    check(
      'the +/- buttons stay reachable and work at max zoom',
      bad.length === 0 && works,
      bad.length
        ? bad.map(([name, b]) => `${name} ${b.size}${b.covered ? ' covered' : ''}${b.inside ? '' : ' offscreen'}`).join('; ')
        : `all three 44px and clear; + at max held scale ${stillMax.scale.toFixed(2)}, six − returned to ${zoomedOut.scale.toFixed(2)} with ${zoomedOut.onScreen}/${zoomedOut.positions.length} ports on screen`,
    );
  }

  // --- PANNING INTO NOTHING ---------------------------------------------
  //
  // The clamp is drawn around the VIEWPORT, not around the ports. The
  // projection leaves wide empty margins (the map is fitted on its long
  // axis), and those margins scale with the zoom, so an ordinary drag can
  // land on a screen with no port on it at all and no clue which way to go
  // back. This is the same family as the "map looks cut off" report.
  await freshMap();
  {
    const box = await mapArea();
    await zoomBy(2, box);
    let worst = { count: Infinity, where: '' };
    for (const [dx, dy, where] of [
      [-240, 0, 'panned fully east'],
      [240, 0, 'panned fully west'],
      [0, -360, 'panned fully south'],
      [0, 360, 'panned fully north'],
    ]) {
      const state = await panToLimit(dx, dy, box);
      if (state.onScreen < worst.count) worst = { count: state.onScreen, where };
      if (state.onScreen === 0) await shoot(`empty-sea-${where.replace(/\s+/g, '-')}`);
      // Come back to the middle so the next direction starts from a
      // comparable place rather than from the far corner.
      await panToLimit(-dx, -dy, box);
      await panToLimit(dx / 2, dy / 2, box);
    }
    check(
      'panning never leaves a screen with no ports on it',
      worst.count > 0,
      `${worst.where} at scale 4 shows ${worst.count} of 42 ports`,
    );
  }

  // --- OVERSCROLL -------------------------------------------------------
  //
  // The clamp deliberately allows 8% of overscroll so a pan does not feel
  // like it hits a wall. Nothing ever springs it back, so the map simply
  // stays there — and at scale 1, where the whole map is meant to fit, that
  // parks ports outside the viewBox for good.
  await freshMap();
  {
    const box = await mapArea();
    await dragTo(box.x + 60, box.y + box.height / 2, box.x + box.width - 40, box.y + box.height / 2);
    await page.waitForTimeout(500);
    const state = await readMap();
    const outside = state.positions.filter(
      (p) => p.x < 0 || p.x > state.W || p.y < 0 || p.y > state.H,
    );
    check(
      'the map springs back after an overscroll drag',
      Math.abs(state.ox) < 1 && Math.abs(state.oy) < 1,
      `offset rests at ${Math.round(state.ox)},${Math.round(state.oy)} at scale ${state.scale.toFixed(2)}${outside.length ? `, leaving ${outside.map((p) => p.name).join(' and ')} outside the viewBox` : ''}`,
    );
    if (outside.length) await shoot('overscroll-rest');
  }

  // --- LABELS AT ZOOM ---------------------------------------------------
  //
  // The clipped-label check above runs at the opening view only. The label
  // anchoring depends on the screen x of the port, so it has to hold at
  // every zoom and pan too.
  await freshMap();
  {
    const box = await mapArea();
    await zoomBy(2, box);
    await panToLimit(-240, 0, box);
    const clippedZoomed = await page.evaluate(() => {
      const width = document.querySelector('svg').viewBox.baseVal.width;
      return [...document.querySelectorAll('svg text')]
        .filter((t) => {
          const b = t.getBBox();
          return b.x < -0.5 || b.x + b.width > width + 0.5;
        })
        .map((t) => t.textContent);
    });
    check(
      'no port label is clipped when zoomed in and panned',
      clippedZoomed.length === 0,
      clippedZoomed.join(', '),
    );
  }

  console.log(`\nScreenshots (if any) are in ${SHOT_DIR}`);

  await browser.close();
} finally {
  stopVite();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} touch checks passed.`);
console.log(
  'Reminder: Chromium has no gesturestart, so iOS Safari page zoom is NOT covered here.',
);
process.exit(failed.length === 0 ? 0 : 1);
