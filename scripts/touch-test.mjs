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
import { existsSync } from 'node:fs';

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
