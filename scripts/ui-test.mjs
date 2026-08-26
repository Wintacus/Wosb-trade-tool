/**
 * Drive the non-map screens with a real browser at a real phone size.
 *
 * Why this exists: the map's four worst bugs — five-pixel tap targets, panning
 * that tracked at 0.36x, clustering that never fired, labels clipped off the
 * edge — all passed 390 unit tests and were found by a person on a phone.
 * Those tests render components to a string: no browser, no layout, no boxes,
 * no fingers. Results and the ship picker have never been opened in a browser
 * at all. This script measures them where it counts.
 *
 * It drives app-harness.html, which mounts the REAL Results and ShipPicker
 * inside the same shell App.tsx uses, with fixture data and the real
 * calculator. The deployed site needs Supabase credentials that do not exist
 * in this environment, so the harness is the only way to render these screens
 * here at all.
 *
 * WHAT IT CANNOT DO:
 *   - Chromium only. Anything specific to iOS Safari (gesture events, the
 *     dynamic viewport, its form controls) is out of reach; WebKit cannot be
 *     downloaded here.
 *   - Fixture data. It proves the screens survive a plausible route, not that
 *     every real route renders.
 *   - It does not test App.tsx's own flow, only the two screens it mounts.
 *
 * Usage (playwright is installed per-session, deliberately not a dependency —
 * CI has no browser to run this on):
 *
 *   node scripts/ui-test.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const PORT = 5200;
const BASE = `http://localhost:${PORT}/app-harness.html`;
const RESULTS = `${BASE}?screen=results`;
const RESULTS_UNVERIFIED = `${BASE}?screen=results&data=unverified`;
const SHIPS = `${BASE}?screen=ships`;
const SHOTS =
  '/tmp/claude-0/-home-user-Wosb-trade-tool/d69cf647-95e5-585d-a081-77807cd97492/scratchpad';
const CHROME_CANDIDATES = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
];
/** Apple's HIG and Android's Material both put the floor at 44 CSS px. */
const MIN_TAP = 44;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('playwright is not installed. Run:  npm i -D playwright --no-save');
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
// killing it can orphan the vite server and leave the port held.
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

// ---------------------------------------------------------------- in-page probes

/** Every visible control, with the tap target a thumb actually gets. */
const controlProbe = () => {
  const out = [];
  for (const el of document.querySelectorAll('button, input, select, a, summary')) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (r.width < 1 || r.height < 1) continue;
    // A 20px checkbox inside a 44px label is a 44px target: tapping the label
    // toggles the box. Measuring the input alone would be a false failure.
    let target = r.height;
    const wrapping = el.closest('label');
    const labelled = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    for (const label of [wrapping, labelled]) {
      if (label && label.contains(el)) target = Math.max(target, label.getBoundingClientRect().height);
      else if (label) target = Math.max(target, label.getBoundingClientRect().height);
    }
    out.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      height: Math.round(r.height * 10) / 10,
      target: Math.round(target * 10) / 10,
      text: (el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 48),
    });
  }
  return out;
};

/** Anything whose own box runs past the screen, ignoring legitimate scrollers. */
const offscreenProbe = () => {
  const inScroller = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === 'auto' || o === 'scroll' || o === 'hidden') return true;
    }
    return false;
  };
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (cs.position === 'fixed' || cs.position === 'absolute') continue; // sr-only clips
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (inScroller(el)) continue;
    if (r.right > window.innerWidth + 1 || r.left < -1) {
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: el.className.toString().slice(0, 40),
        left: Math.round(r.left),
        right: Math.round(r.right),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      });
    }
  }
  return out;
};

/** Text hidden by its own container: content wider than the box that clips it. */
const clippedProbe = () => {
  const out = [];
  // span and li are in here deliberately: `truncate` is applied to inner spans,
  // so a selector without them silently reports zero truncations on a screen
  // full of them.
  const selector = 'h1,h2,h3,p,dt,dd,summary,legend,caption,button,th,td,label,span,li';
  for (const el of document.querySelectorAll(selector)) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
    // `sr-only` is *meant* to be a clipped 1px box: that is how text is hidden
    // from sighted users and left for screen readers. Flagging it was a false
    // failure of this script's first run, not a bug on the screen.
    if (cs.position === 'absolute' && (el.clientWidth <= 1 || cs.clipPath !== 'none')) continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    // `truncate` (text-overflow: ellipsis) is a deliberate choice, not a bug:
    // it shows the reader that a name was shortened.
    const ellipsis = cs.textOverflow === 'ellipsis';
    out.push({
      tag: el.tagName.toLowerCase(),
      ellipsis,
      overflow: cs.overflowX,
      by: el.scrollWidth - el.clientWidth,
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    });
  }
  return out;
};

/** Row order plus which rows the plan chose, straight off the rendered table. */
const tableProbe = () =>
  [...document.querySelectorAll('tbody tr')].map((tr) => ({
    name: (tr.querySelector('th')?.textContent || '').trim(),
    inPlan: tr.className.includes('amber'),
  }));

/** Names of the saved presets, in list order. */
const presetProbe = () => {
  const panel = [...document.querySelectorAll('section')].find(
    (s) => s.querySelector('h2')?.textContent?.trim() === 'Your ships',
  );
  if (!panel) return [];
  return [...panel.querySelectorAll('li button[aria-pressed]')].map((b) =>
    (b.querySelector('span span')?.textContent || '').trim(),
  );
};

// ---------------------------------------------------------------- the suite

async function runSuite(browser, device) {
  const label = device.label;
  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    hasTouch: device.hasTouch,
    isMobile: device.isMobile,
    deviceScaleFactor: device.dsf,
  });
  const page = await context.newPage();

  /**
   * Every check starts from a freshly loaded screen.
   *
   * The map's touch test taught this the hard way: its pan and pinch checks
   * left the map dragged and zoomed, and three later checks reported failures
   * that were entirely the test's own doing. Sorting a table and creating
   * presets are state too.
   */
  const reset = async (url, ready) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForSelector(ready);
  };
  const RESULTS_READY = 'table tbody tr';
  const SHIPS_READY = 'button[aria-label$="as a preset"]';

  // 1. The page must never scroll sideways. The table is allowed to; the page
  //    is not — a phone user swiping a table should not drag the whole screen.
  for (const [name, url, ready] of [
    ['results', RESULTS, RESULTS_READY],
    ['results (unverified)', RESULTS_UNVERIFIED, RESULTS_READY],
    ['ships', SHIPS, SHIPS_READY],
  ]) {
    await reset(url, ready);
    const doc = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    check(
      `${label}: no horizontal page overflow — ${name}`,
      doc.scrollWidth <= doc.clientWidth,
      `scrollWidth ${doc.scrollWidth} vs clientWidth ${doc.clientWidth}`,
    );

    const off = await page.evaluate(offscreenProbe);
    check(
      `${label}: nothing sits off the side of the screen — ${name}`,
      off.length === 0,
      off
        .slice(0, 4)
        .map((o) => `<${o.tag}> ${o.left}..${o.right} "${o.text}"`)
        .join(' | '),
    );
  }

  // 2. The supporting table scrolls inside its own container.
  await reset(RESULTS, RESULTS_READY);
  const scroller = await page.evaluate(() => {
    const table = document.querySelector('table');
    const box = table?.parentElement;
    if (!box) return null;
    const before = box.scrollLeft;
    box.scrollLeft = 240;
    const after = box.scrollLeft;
    box.scrollLeft = before;
    return {
      overflowX: getComputedStyle(box).overflowX,
      scrollWidth: box.scrollWidth,
      clientWidth: box.clientWidth,
      moved: after,
    };
  });
  check(
    `${label}: the supporting table scrolls inside its own container`,
    scroller !== null &&
      scroller.overflowX === 'auto' &&
      (device.width < 900 ? scroller.scrollWidth > scroller.clientWidth && scroller.moved > 0 : true),
    scroller
      ? `overflow-x ${scroller.overflowX}, content ${scroller.scrollWidth}px in ${scroller.clientWidth}px, scrolled to ${scroller.moved}`
      : 'no table found',
  );

  // 2b. And it scrolls under an actual finger, not just under scrollLeft.
  //     Setting scrollLeft proves the container is scrollable; it does not
  //     prove a thumb can move it, which is the only way a phone user will.
  if (device.hasTouch) {
    await reset(RESULTS, RESULTS_READY);
    const surface = await (await page.$('table')).boundingBox();
    const cdp = await page.context().newCDPSession(page);
    const y = Math.min(Math.max(surface.y + 20, 100), device.height - 100);
    const fromX = device.width - 40;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: fromX, y, id: 1 }],
    });
    for (let i = 1; i <= 8; i += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: fromX - i * 25, y, id: 1 }],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(200);
    const dragged = await page.evaluate(() => ({
      table: document.querySelector('table')?.parentElement?.scrollLeft ?? -1,
      page: window.scrollX,
    }));
    check(
      `${label}: dragging the table sideways scrolls the table, not the page`,
      dragged.table > 20 && dragged.page === 0,
      `table scrolled ${Math.round(dragged.table)}px, page scrolled ${dragged.page}px`,
    );
  }

  // 3. Tap targets. Every control a thumb has to hit, on every screen.
  for (const [name, url, ready] of [
    ['results', RESULTS, RESULTS_READY],
    ['ships', SHIPS, SHIPS_READY],
  ]) {
    await reset(url, ready);
    const controls = await page.evaluate(controlProbe);
    const small = controls.filter((c) => c.target < MIN_TAP - 0.5);
    check(
      `${label}: every control is at least ${MIN_TAP}px tall — ${name}`,
      small.length === 0,
      small.length === 0
        ? `${controls.length} controls checked`
        : small
            .map((c) => `<${c.tag}${c.type ? ` type=${c.type}` : ''}> ${c.target}px "${c.text}"`)
            .join(' | '),
    );
  }

  // 3b. And the controls that only exist once a preset is being edited.
  await reset(SHIPS, SHIPS_READY);
  await page.click('button[aria-label$="as a preset"]');
  await page.click('button:has-text("Save preset")');
  await page.click('button[aria-label^="Edit "]');
  await page.waitForSelector('input[type="checkbox"]');
  const editControls = await page.evaluate(controlProbe);
  const smallEdit = editControls.filter((c) => c.target < MIN_TAP - 0.5);
  check(
    `${label}: every control is at least ${MIN_TAP}px tall — preset editor`,
    smallEdit.length === 0,
    smallEdit.length === 0
      ? `${editControls.length} controls checked`
      : smallEdit
          .map((c) => `<${c.tag}${c.type ? ` type=${c.type}` : ''}> own ${c.height}px, target ${c.target}px "${c.text}"`)
          .join(' | '),
  );

  // 4. Sorting must actually reorder the table, and must never bury a good the
  //    plan chose below one it rejected — that would contradict the screen above.
  await reset(RESULTS, RESULTS_READY);
  const sortButtons = await page.$$('[aria-label="Sort the table by"] button');
  check(`${label}: the table offers four sort controls`, sortButtons.length === 4, `${sortButtons.length} found`);
  const orders = new Map();
  let planAlwaysFirst = true;
  for (const button of sortButtons) {
    const name = (await button.textContent()).replace('✓', '').trim();
    await button.click();
    await page.waitForTimeout(80);
    const rows = await page.evaluate(tableProbe);
    orders.set(name, rows.map((r) => r.name).join('>'));
    const lastPlan = rows.map((r) => r.inPlan).lastIndexOf(true);
    const firstRejected = rows.map((r) => r.inPlan).indexOf(false);
    if (lastPlan > -1 && firstRejected > -1 && lastPlan > firstRejected) planAlwaysFirst = false;
  }
  const distinct = new Set(orders.values());
  check(
    `${label}: the sort control reorders the table`,
    distinct.size > 1,
    `${distinct.size} distinct orders from ${orders.size} sorts`,
  );
  check(
    `${label}: "Per weight" ranks differently from "Total profit"`,
    orders.get('Per weight') !== orders.get('Total profit'),
    orders.get('Per weight') === orders.get('Total profit') ? 'identical order' : '',
  );
  check(
    `${label}: "ROI" ranks differently from "Total profit"`,
    orders.get('ROI') !== orders.get('Total profit'),
    orders.get('ROI') === orders.get('Total profit') ? 'identical order' : '',
  );
  check(`${label}: goods in the plan always sort above rejected goods`, planAlwaysFirst);

  // 5. Unverified caveats must be on screen, not merely in the DOM. A caveat
  //    behind something is the same as no caveat (CLAUDE.md rule 5).
  await reset(RESULTS_UNVERIFIED, RESULTS_READY);
  const wanted = [
    ['unknown tax', 'Nobody has recorded the sales tax'],
    ['unverified docking fee', 'Docking fees have never been confirmed'],
    ['demo prices', 'example data that came with the app'],
    ['unverified ship stats', 'have not been checked against an in-game ship card'],
  ];
  for (const [what, needle] of wanted) {
    const state = await page.evaluate((text) => {
      // Scoped to the "Worth knowing" panel on purpose. The return leg repeats
      // the tax sentence inside a COLLAPSED <details>, which has a layout box
      // but is not painted — matching that copy reported the caveat as hidden
      // when the visible one was fine. A false failure of this script's own.
      const panel = [...document.querySelectorAll('section')].find(
        (s) => s.querySelector('h3')?.textContent?.trim() === 'Worth knowing',
      );
      if (!panel) return { found: false, noPanel: true };
      const el = [...panel.querySelectorAll('p, span')].find(
        (n) => n.textContent && n.textContent.includes(text),
      );
      if (!el) return { found: false };
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const inViewport = x >= 0 && x <= window.innerWidth && y >= 0 && y <= window.innerHeight;
      const hit = inViewport ? document.elementFromPoint(x, y) : null;
      return {
        found: true,
        width: Math.round(r.width),
        height: Math.round(r.height),
        onScreen: inViewport,
        opacity: cs.opacity,
        covered: !hit || !(hit === el || el.contains(hit) || hit.contains(el)),
      };
    }, needle);
    check(
      `${label}: the ${what} caveat is rendered and visible`,
      state.found && state.width > 0 && state.height > 0 && state.onScreen && !state.covered && state.opacity !== '0',
      state.found
        ? `${state.width}x${state.height}${state.covered ? ' COVERED' : ''}`
        : state.noPanel
          ? 'no "Worth knowing" panel rendered at all'
          : 'text not in the "Worth knowing" panel',
    );
  }
  const caveatOnVerified = await reset(RESULTS, RESULTS_READY).then(() =>
    page.evaluate(() => document.body.textContent.includes('Nobody has recorded the sales tax')),
  );
  check(
    `${label}: no unknown-tax caveat when the tax IS known`,
    caveatOnVerified === false,
    caveatOnVerified ? 'caveat shown for a port with a recorded tax' : '',
  );

  // 6. Nothing may be clipped or spilling out of its own box.
  for (const [name, url, ready] of [
    ['results', RESULTS, RESULTS_READY],
    ['ships', SHIPS, SHIPS_READY],
  ]) {
    await reset(url, ready);
    const clipped = await page.evaluate(clippedProbe);
    const real = clipped.filter((c) => !c.ellipsis);
    check(
      `${label}: no text is clipped or overflowing its container — ${name}`,
      real.length === 0,
      real.length === 0
        ? `${clipped.length} deliberate ellipsis truncations, 0 clipped`
        : real.map((c) => `<${c.tag}> +${c.by}px overflow-${c.overflow} "${c.text}"`).join(' | '),
    );
  }

  // 7. Presets, end to end: save, rename in place, delete, undo.
  await reset(SHIPS, SHIPS_READY);
  const saveButtons = await page.$$('button[aria-label$="as a preset"]');
  const firstShip = (await saveButtons[0].getAttribute('aria-label')).replace(/^Save /, '').replace(/ as a preset$/, '');
  const secondShip = (await saveButtons[1].getAttribute('aria-label')).replace(/^Save /, '').replace(/ as a preset$/, '');
  await saveButtons[0].click();
  await page.click('button:has-text("Save preset")');
  await page.waitForTimeout(60);
  await (await page.$$('button[aria-label$="as a preset"]'))[1].click();
  await page.click('button:has-text("Save preset")');
  await page.waitForTimeout(60);
  const afterCreate = await page.evaluate(presetProbe);
  check(
    `${label}: a preset saved from a base ship appears in "Your ships"`,
    afterCreate.length === 2 && afterCreate[0] === firstShip && afterCreate[1] === secondShip,
    afterCreate.join(', ') || 'none',
  );

  const renamed = `${firstShip} (loaded)`;
  await page.click(`button[aria-label="Edit ${firstShip}"]`);
  await page.waitForSelector('input[type="checkbox"]');
  const nameInput = await page.$('li input[type="text"]');
  await nameInput.fill(renamed);
  await page.click('button:has-text("Save changes")');
  await page.waitForTimeout(80);
  const afterRename = await page.evaluate(presetProbe);
  check(
    `${label}: an inline rename persists after saving`,
    afterRename[0] === renamed,
    afterRename.join(', ') || 'none',
  );

  await page.click(`button[aria-label="Delete ${renamed}"]`);
  await page.waitForSelector('[role="alertdialog"]');
  await page.click('[role="alertdialog"] button:has-text("Delete")');
  await page.waitForTimeout(80);
  const afterDelete = await page.evaluate(presetProbe);
  const undoBar = await page.$('[role="status"]');
  const undoText = undoBar ? (await undoBar.textContent()).replace(/\s+/g, ' ').trim() : '';
  check(
    `${label}: deleting a preset removes it and offers an undo`,
    afterDelete.length === 1 && afterDelete[0] === secondShip && undoText.includes('Deleted'),
    `${afterDelete.join(', ') || 'none'} · undo bar: ${undoText || 'absent'}`,
  );

  await page.click('[role="status"] button:has-text("Undo")');
  await page.waitForTimeout(80);
  const afterUndo = await page.evaluate(presetProbe);
  check(
    `${label}: undo restores the preset in its original position`,
    afterUndo.length === 2 && afterUndo[0] === renamed && afterUndo[1] === secondShip,
    afterUndo.join(', ') || 'none',
  );

  // 8. Screenshots, at phone size only. Looked at by a human (or a model with
  //    eyes) afterwards — this is how the last four map bugs were found.
  if (device.shots) {
    mkdirSync(SHOTS, { recursive: true });
    for (const [name, url, ready] of [
      ['results', RESULTS, RESULTS_READY],
      ['results-unverified', RESULTS_UNVERIFIED, RESULTS_READY],
      ['ships', SHIPS, SHIPS_READY],
    ]) {
      await reset(url, ready);
      await page.screenshot({ path: `${SHOTS}/${name}-390.png` });
      await page.screenshot({ path: `${SHOTS}/${name}-390-full.png`, fullPage: true });
    }
    // The table scrolled fully right: a state a phone user reaches within one
    // swipe, and the only way to read the "Why not" column at this width.
    await reset(RESULTS, RESULTS_READY);
    await page.evaluate(() => {
      const box = document.querySelector('table')?.parentElement;
      if (box) box.scrollLeft = box.scrollWidth;
      document.querySelector('table')?.scrollIntoView({ block: 'start' });
    });
    await page.waitForTimeout(80);
    await page.screenshot({ path: `${SHOTS}/results-table-scrolled-390.png` });

    // The preset editor open, because that is the densest state on the screen.
    await reset(SHIPS, SHIPS_READY);
    await page.click('button[aria-label$="as a preset"]');
    await page.click('button:has-text("Save preset")');
    await page.click('button[aria-label^="Edit "]');
    await page.waitForSelector('input[type="checkbox"]');
    await page.screenshot({ path: `${SHOTS}/ships-editing-390-full.png`, fullPage: true });
    console.log(`\nScreenshots written to ${SHOTS}`);
  }

  await context.close();
}

try {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(RESULTS);
      if (response.ok) break;
    } catch {
      /* not up yet */
    }
    if (attempt > 60) throw new Error('vite did not start');
    await new Promise((r) => setTimeout(r, 500));
  }

  const browser = await chromium.launch({ executablePath });
  await runSuite(browser, {
    label: 'phone 390',
    width: 390,
    height: 844,
    hasTouch: true,
    isMobile: true,
    dsf: 3,
    shots: true,
  });
  await runSuite(browser, {
    label: 'desktop 1280',
    width: 1280,
    height: 800,
    hasTouch: false,
    isMobile: false,
    dsf: 1,
    shots: false,
  });
  await browser.close();
} finally {
  stopVite();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed.`);
if (failed.length > 0) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
}
console.log('Reminder: Chromium only, fixture data, and App.tsx’s own flow is not covered.');
process.exit(failed.length === 0 ? 0 : 1);
