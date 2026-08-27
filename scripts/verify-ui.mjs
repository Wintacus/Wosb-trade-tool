/**
 * Drives the REAL app in a real browser and checks what a person would check.
 *
 * Why this exists, plainly: three times in one day a fix was reported to the
 * user as working when it was not, because "working" had been decided by unit
 * tests and by reading the diff. Unit tests pass on an app that wipes all your
 * work the moment you switch to another app; reading a diff cannot tell you
 * that a button opens a screen indistinguishable from step 1.
 *
 * So this is not a unit test. It boots the actual site with the real
 * data/*.json behind a mocked PostgREST, drives it at phone size, and asserts
 * the things that were actually reported broken — including a page RELOAD,
 * which is what iOS does to a backgrounded tab and which no other test in this
 * repo performs.
 *
 * Run it with `npm run verify`. It writes .verified in the repo root recording
 * what it checked and against which working tree, and the Stop hook in
 * .claude/settings.json refuses to end a turn that changed src/ without it.
 *
 * NEVER run `pkill -f vite` here or anywhere in this repo: `pkill -f` matches
 * the shell's own command line, which contains the word "vite", so it kills
 * the process about to run the tests. That cost most of a session once.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';

const CHROME = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
].find((p) => existsSync(p));

if (!CHROME) {
  console.error('No Chromium found under /opt/pw-browsers. Cannot verify.');
  process.exit(1);
}

let chromium, devices;
try {
  ({ chromium, devices } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm i playwright --no-save');
  process.exit(1);
}

const PORT = 5199;
const checks = [];
const fail = (name, detail) => checks.push({ ok: false, name, detail });
const pass = (name, detail = '') => checks.push({ ok: true, name, detail });

// ---------------------------------------------------------------------
// Fixtures: the real game data, reshaped into the snake_case rows that
// src/data/mappers.ts expects. Prices are synthetic and clearly fake.
// ---------------------------------------------------------------------
const rawPorts = JSON.parse(readFileSync('data/ports.json', 'utf8')).ports;
const rawShips = JSON.parse(readFileSync('data/ships.json', 'utf8')).ships;
const rawGoods = JSON.parse(readFileSync('data/goods.json', 'utf8')).goods;
const resFile = JSON.parse(readFileSync('data/resources.json', 'utf8'));
const rawRes = [...(resFile.craftMaterials ?? []), ...(resFile.specialItems ?? [])];

const TABLES = {
  ports: rawPorts.map((p) => ({
    id: p.id, name: p.name, display_name: p.displayName ?? null,
    x: p.x, y: p.y, category: p.category ?? null,
  })),
  ships: rawShips.map((s) => ({
    id: s.id, name: s.name, class: s.class, hull_type: s.hullType ?? null,
    rate: s.rate, durability: s.durability ?? null, speed: s.speed ?? null,
    maneuverability: s.maneuverability ?? null, armor: s.armor ?? null,
    hold: s.hold, crew: s.crew ?? null, upgrade_slots: s.upgradeSlots ?? null,
    verified: s.verified !== false,
  })),
  goods: [
    ...rawGoods.map((g) => ({
      id: g.id, name: g.name, weight: g.weight, base_value: g.baseValue ?? null,
      min_price: g.minPrice ?? null, max_price: g.maxPrice ?? null,
      is_trade_good: true, perishable: g.perishable === true, category: null,
    })),
    ...rawRes.map((r) => ({
      id: r.id, name: r.name, weight: r.weight ?? 1, base_value: r.baseValue ?? null,
      min_price: r.minPrice ?? null, max_price: r.maxPrice ?? null,
      is_trade_good: false, perishable: r.perishable === true, category: null,
    })),
  ],
  upgrades: [],
  servers: [{ id: 'na', name: 'North America' }],
  port_state_current: [],
  // Prices at the port the entry sheet opens on.
  //
  // This list used to be EMPTY, and that is exactly how a real bug shipped:
  // with nothing on record every good rendered the short "not recorded here"
  // branch, so the populated row -- the one carrying "buy 7.0 · sell 7.0 ·
  // stock not shown" plus a freshness badge -- was never drawn here, and the
  // good's NAME being squeezed to zero width by it went unseen until a phone
  // found it. A fixture with no data only ever tests the empty state.
  prices_current: (() => {
    const port = rawPorts.find((p) => (p.displayName ?? p.name) === 'Al-Khalif');
    if (!port) return [];
    const stale = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    return rawGoods.map((g, i) => ({
      server_id: 'na',
      port_id: port.id,
      good_id: g.id,
      // Deliberately the widest shape the row can take: every field present,
      // a long "stock not shown", and a demo flag adding its own note.
      buy_price: (g.minPrice ?? 5) * 10,
      sell_price: (g.minPrice ?? 5) * 10,
      stock: null,
      observed_at: stale,
      is_demo: i % 2 === 0,
      source: i % 2 === 0 ? 'demo' : 'manual',
    }));
  })(),
};

// detached so the whole process group can be signalled at the end. Without
// it, SIGTERM reaches `npx` and the real vite process is orphaned to init,
// still holding the port -- and the next run dies with a bare "Vite did not
// start" that says nothing about why. That cost three runs to work out once.
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  detached: true,
  env: {
    ...process.env,
    VITE_SUPABASE_URL: 'https://verify.invalid',
    VITE_SUPABASE_ANON_KEY: 'verify-only',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let ready = false;
// Kept so a failure to start can say WHY. It used to report only "Vite did not
// start", which is true and useless -- the actual message ("Port 5199 is
// already in use") was being thrown away.
let viteLog = '';
vite.stdout.on('data', (d) => {
  const s = d.toString();
  viteLog += s;
  if (s.includes('ready in') || s.includes('Local:')) ready = true;
});
vite.stderr.on('data', (d) => {
  viteLog += d.toString();
});

const started = Date.now();
while (!ready) {
  if (Date.now() - started > 40_000) {
    console.error(`Vite did not start. Last output:\n${viteLog.slice(-1200)}`);
    try {
      process.kill(-vite.pid, 'SIGTERM');
    } catch {
      vite.kill('SIGTERM');
    }
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 100));
}
await new Promise((r) => setTimeout(r, 600));

const browser = await chromium.launch({ executablePath: CHROME });
const context = await browser.newContext({ ...devices['iPhone 14 Pro Max'] });
const page = await context.newPage();

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  // The run deliberately makes /api/ocr answer 429 once, to prove a refused
  // upload is explained rather than swallowed. Chromium logs every non-2xx
  // response as a console error, so that expected one is not a defect.
  const expected = /Failed to load resource.*429/.test(m.text());
  if (m.type() === 'error' && !expected) pageErrors.push(m.text());
});

await page.route('**/rest/v1/**', (route) => {
  const table = new URL(route.request().url()).pathname.split('/').pop();
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(TABLES[table] ?? []),
  });
});
// Saving needs an account; this run is about the UI, not the database.
await page.route('**/auth/v1/**', (r) => r.fulfill({ status: 501, body: '{}' }));
await page.route('**/api/anon-session', (r) => r.fulfill({ status: 501, body: '{}' }));

const text = async () => page.locator('body').innerText();
const ORIGIN = 'Al-Khalif';
const DEST = 'Aruba';
const SHIP = rawShips[0].name;

try {
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
  await page.getByText('North America', { exact: false }).first().click().catch(() => {});
  await page.waitForTimeout(400);

  // --- the four-step flow completes at all -------------------------------
  await page.getByText(ORIGIN, { exact: false }).first().click({ timeout: 8000 });
  await page.waitForTimeout(300);
  await page.getByText(DEST, { exact: false }).first().click({ timeout: 8000 });
  await page.waitForTimeout(300);
  await page.getByText(SHIP, { exact: false }).first().click({ timeout: 8000 });
  await page.waitForTimeout(700);

  const afterFlow = await text();
  if (afterFlow.includes(ORIGIN) && afterFlow.includes(DEST)) {
    pass('the four-step flow reaches a result');
  } else {
    fail('the four-step flow reaches a result', 'route missing from the results screen');
  }

  // --- THE BIG ONE: a reload must not wipe the user's work ---------------
  // iOS Safari reloads a backgrounded tab whenever it wants the memory, and
  // this tool is used by switching to the game and back constantly. Losing
  // the route here is losing it in real use.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  const afterReload = await text();
  if (afterReload.includes(ORIGIN) && afterReload.includes(DEST)) {
    pass('a reload keeps the route and ship', `${ORIGIN} -> ${DEST} survived`);
  } else {
    fail(
      'a reload keeps the route and ship',
      'the route was wiped by a reload — this is what iOS does to a backgrounded tab',
    );
  }

  // --- "Add prices" must not look like a reset ---------------------------
  const addBtn = page.getByRole('button', { name: 'Add prices', exact: true });
  if (await addBtn.isVisible().catch(() => false)) {
    await addBtn.click({ timeout: 8000 });
    await page.waitForTimeout(800);
    const entry = await text();
    if (entry.includes('Prices at')) {
      pass('"Add prices" opens the entry sheet directly', 'not the port picker');
    } else if (entry.includes('Which port are you at?')) {
      fail(
        '"Add prices" opens the entry sheet directly',
        'it showed the port picker, which is indistinguishable from step 1 and reads as a reset',
      );
    } else {
      fail('"Add prices" opens the entry sheet directly', 'unrecognised screen');
    }
  } else {
    fail('"Add prices" opens the entry sheet directly', 'button not found');
  }

  // --- typed prices must survive a reload too ----------------------------
  const priceInputs = await page.locator('input[inputmode="decimal"]').all();
  if (priceInputs.length > 0) {
    await priceInputs[0].fill('18.9');
    await page.waitForTimeout(400);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    const restored = await page.locator('input[inputmode="decimal"]').first().inputValue().catch(() => '');
    if (restored === '18.9') {
      pass('typed prices survive a reload', 'still 18.9 after reload');
    } else {
      fail('typed prices survive a reload', `expected 18.9, got "${restored}"`);
    }
  } else {
    fail('typed prices survive a reload', 'no price input found to type into');
  }

  // --- price entry works when opened BEFORE a route exists --------------
  //
  // The most natural way into this app: you are standing in a port with no
  // route planned, and you tap "Add prices". That path was completely broken
  // and shipped that way -- every keystroke was discarded, the field stayed
  // empty and the save bar stayed "Nothing entered yet".
  //
  // The cause was two sources of truth for one fact: PriceEntry held its own
  // `portId`, App keyed the drafts by a separate copy, and with no route the
  // copy was null so `onDraftsChange` early-returned on every keystroke.
  //
  // The checks above all missed it because they open the sheet only AFTER
  // completing the four-step flow, which makes App's copy non-null. Testing
  // the convenient path is not testing the path people use.
  {
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      try { localStorage.clear(); } catch { /* private mode */ }
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText('North America', { exact: false }).first().click().catch(() => {});
    await page.waitForTimeout(500);

    const add = page.getByRole('button', { name: 'Add prices', exact: true });
    await add.click({ timeout: 8000 });
    await page.waitForTimeout(400);
    await page.getByText(ORIGIN, { exact: false }).first().click({ timeout: 8000 });
    await page.waitForTimeout(700);

    const field = page.locator('input[inputmode="decimal"]').first();
    await field.fill('18.9');
    await page.waitForTimeout(400);
    const typed = await field.inputValue().catch(() => '');
    if (typed === '18.9') {
      pass('prices can be typed when entry is opened before a route', 'field holds 18.9');
    } else {
      fail(
        'prices can be typed when entry is opened before a route',
        `typed "18.9" but the field reads "${typed}" — keystrokes are being discarded`,
      );
    }

    // --- and changing port must not carry the numbers to the wrong port ---
    //
    // Worse than losing them: the header said one port while the fields still
    // held another port's numbers, and Save wrote them under the port on
    // screen WITH a success banner. Silent bad data in a shared database.
    await page.getByRole('button', { name: 'Change port' }).click({ timeout: 8000 });
    await page.waitForTimeout(400);
    await page.getByText(DEST, { exact: false }).first().click({ timeout: 8000 });
    await page.waitForTimeout(700);
    const heading = await page.locator('h2').first().innerText().catch(() => '');
    const after = await page.locator('input[inputmode="decimal"]').first().inputValue().catch(() => 'x');
    if (heading.includes(DEST) && after === '') {
      pass('changing port clears the previous port\'s numbers', `now "${heading.trim()}"`);
    } else {
      fail(
        'changing port clears the previous port\'s numbers',
        `heading "${heading.trim()}" but the field still reads "${after}"`,
      );
    }
  }

  // --- reading a screenshot fills the sheet without trampling anyone -----
  //
  // OCR (SPEC 7.2) is the whole point of the tool -- typing 61 numbers per
  // port by hand is not something anybody will keep doing -- so the parts that
  // can be checked without a real game screenshot are checked here: that the
  // values land in the review sheet, that a number a PERSON typed is never
  // replaced by a machine's opinion, that a screenshot of the wrong port is
  // called out loudly, and that a failure leaves the sheet exactly as it was.
  //
  // The model itself is mocked. Whether it reads a real screenshot correctly
  // is a different question, measured by scripts/ocr-accuracy.mjs against real
  // images, and it is not something a pass/fail check can answer honestly.
  {
    // Uploading needs the invisible account, so the identity endpoints have to
    // answer here. Registered late on purpose: Playwright gives precedence to
    // the most recently added route, so these win over the blanket 501s above.
    await page.route('**/api/anon-session', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: 'anon@anon.invalid', password: 'verify-only' }),
      }),
    );
    await page.route('**/auth/v1/token**', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'verify-only-token',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: 'verify-only-refresh',
          user: {
            id: '00000000-0000-0000-0000-000000000001',
            aud: 'authenticated',
            role: 'authenticated',
            email: 'anon@anon.invalid',
            created_at: new Date().toISOString(),
            app_metadata: {},
            user_metadata: {},
          },
        }),
      }),
    );

    const readable = (goodId, printed, sell) => ({
      goodId, printed, buyText: '', sellText: sell, stockText: '', flags: [],
    });
    let ocrReply = {
      status: 200,
      body: {
        screen: 'market',
        // Deliberately NOT the port the sheet is on, so the mismatch warning
        // is exercised. Saving a correct reading against the wrong port is the
        // most damaging thing this feature can do, and it is silent.
        portName: 'Fiji Bay',
        portKind: 'city',
        rows: [
          readable('beer', 'Beer', '9.9'),
          {
            ...readable('dates', 'Dates', '11.1'),
            // A value that was read but looks wrong. It goes into the sheet
            // either way -- the point is that the person is told which ones to
            // look at first, otherwise the whole list has to be re-checked and
            // the feature has saved nobody anything.
            flags: ['Higher than any Dates price recorded before — check the decimal point.'],
          },
        ],
        rejected: [{ printed: 'Krakenweed', reason: 'Not one of the goods this app knows about.' }],
        notes: null,
      },
    };
    await page.route('**/api/ocr', (r) =>
      r.fulfill({
        status: ocrReply.status,
        contentType: 'application/json',
        body: JSON.stringify(ocrReply.body),
      }),
    );

    const sheet = await page.locator('h2').first().innerText().catch(() => '');

    // A number this person typed themselves, which must survive the upload.
    const beerField = page.locator('input[inputmode="decimal"]').first();
    await beerField.fill('7.7');
    await page.waitForTimeout(300);

    // A 1x1 PNG: real enough for createImageBitmap and the canvas re-encode,
    // which is the step that strips EXIF before anything leaves the device.
    const ONE_PIXEL_PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    await page.setInputFiles('input[type="file"]', {
      name: 'market.png',
      mimeType: 'image/png',
      buffer: ONE_PIXEL_PNG,
    });
    await page.waitForTimeout(1500);

    const state = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('li')].filter((li) =>
        li.querySelector('input[inputmode]'),
      );
      const read = rows.slice(0, 12).map((row) => ({
        name: (row.querySelector('span')?.textContent ?? '').trim(),
        sell: row.querySelector('input[inputmode="decimal"]')?.value ?? '',
        badge: Boolean([...row.querySelectorAll('span')].some((s) => s.textContent === 'read')),
      }));
      return { rows: read, body: document.body.innerText };
    });

    const beer = state.rows.find((r) => r.name.startsWith('Beer'));
    const dates = state.rows.find((r) => r.name.startsWith('Dates'));

    if (dates?.sell === '11.1' && dates.badge) {
      pass('a screenshot fills the entry sheet', 'Dates read as 11.1 and marked "read"');
    } else {
      fail(
        'a screenshot fills the entry sheet',
        `expected Dates 11.1 marked read, got ${JSON.stringify(dates)}`,
      );
    }

    if (beer?.sell === '7.7' && !beer.badge) {
      pass('a screenshot never overwrites what a person typed', 'Beer stayed 7.7, unbadged');
    } else {
      fail(
        'a screenshot never overwrites what a person typed',
        `Beer should still read 7.7 and carry no badge, got ${JSON.stringify(beer)}`,
      );
    }

    if (state.body.includes('Fiji Bay') && /will be saved to/.test(state.body)) {
      pass('a screenshot of the wrong port is called out', `sheet is "${sheet.trim()}"`);
    } else {
      fail(
        'a screenshot of the wrong port is called out',
        'no warning shown, so a correct reading can be saved against the wrong port silently',
      );
    }

    if (state.body.includes('1 row was skipped') || state.body.includes('rows were skipped')) {
      pass('goods the app does not know are reported, not guessed at');
    } else {
      fail('goods the app does not know are reported, not guessed at', 'no skipped-row summary');
    }

    if (/Check 1 value first/.test(state.body) && state.body.includes('decimal point')) {
      pass('values that look wrong are pointed out by name');
    } else {
      fail(
        'values that look wrong are pointed out by name',
        'no flag summary, so a misread decimal point is indistinguishable from a good reading',
      );
    }

    // --- and the filled values survive a reload, like typed ones do -------
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    const afterReloadSell = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('li')].filter((li) =>
        li.querySelector('input[inputmode]'),
      );
      const row = rows.find((r) => (r.querySelector('span')?.textContent ?? '').startsWith('Dates'));
      return row?.querySelector('input[inputmode="decimal"]')?.value ?? '';
    });
    if (afterReloadSell === '11.1') {
      pass('read values survive a reload', 'Dates still 11.1');
    } else {
      fail('read values survive a reload', `expected 11.1, got "${afterReloadSell}"`);
    }

    // --- a refusal is readable and changes nothing -----------------------
    ocrReply = {
      status: 429,
      body: { error: 'That is 30 screenshots this hour, which is the limit. Manual entry still works.' },
    };
    await page.setInputFiles('input[type="file"]', {
      name: 'market.png',
      mimeType: 'image/png',
      buffer: ONE_PIXEL_PNG,
    });
    await page.waitForTimeout(1200);
    const afterFailure = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('li')].filter((li) =>
        li.querySelector('input[inputmode]'),
      );
      const row = rows.find((r) => (r.querySelector('span')?.textContent ?? '').startsWith('Dates'));
      return {
        sell: row?.querySelector('input[inputmode="decimal"]')?.value ?? '',
        body: document.body.innerText,
      };
    });
    if (afterFailure.body.includes('limit') && afterFailure.sell === '11.1') {
      pass('a refused upload explains itself and keeps the sheet', 'Dates still 11.1');
    } else {
      fail(
        'a refused upload explains itself and keeps the sheet',
        `message shown: ${afterFailure.body.includes('limit')}, Dates now "${afterFailure.sell}"`,
      );
    }
  }

  // --- every good's NAME is actually readable ---------------------------
  //
  // Reported from a phone 2026-08-26: after the row was compacted the goods
  // list became a column of prices with no way to tell what any of them were.
  // The name shared a flex row with the "on record" summary, the summary was
  // shrink-0 and wide ("buy 7.0 · sell 7.0 · stock not shown" plus a badge),
  // and the name -- which truncates -- was squeezed to zero width. It needed
  // min-w-0 to shrink correctly and, better, its own line.
  //
  // Checking the TEXT is not enough: a zero-width truncated element still has
  // its text in the DOM. This measures the rendered box.
  {
    const names = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('li')].filter((li) =>
        li.querySelector('input[inputmode]'),
      );
      return rows.slice(0, 8).map((row) => {
        const el = row.querySelector('span');
        const rect = el?.getBoundingClientRect();
        return {
          text: (el?.textContent ?? '').trim(),
          width: rect ? Math.round(rect.width) : 0,
        };
      });
    });
    const unreadable = names.filter((n) => !n.text || n.width < 40);
    if (names.length > 0 && unreadable.length === 0) {
      pass(
        'every good row shows its name',
        `${names.length} checked, narrowest ${Math.min(...names.map((n) => n.width))}px e.g. "${names[0].text}"`,
      );
    } else {
      fail(
        'every good row shows its name',
        names.length === 0
          ? 'no good rows rendered at all'
          : `${unreadable.length} row(s) with no readable name: ${JSON.stringify(unreadable.slice(0, 3))}`,
      );
    }
  }

  // --- the entry sheet stays quick on a phone ---------------------------
  // SPEC 7.1 asks this screen to be fast on a phone. Measured 2026-08-26 it
  // was not: each row was 202px tall, exactly two fitted on a 430x740 screen,
  // and the 20 trade goods took 6.8 screens of scrolling. The height went on
  // repetition -- a "never recorded" badge above an "on record: nothing yet"
  // line, field labels on all 61 rows, and one identical buy-price offer per
  // row. This pins the compact result so it cannot quietly regrow.
  {
    const rows = await page.evaluate(() => {
      const list = [...document.querySelectorAll('li')].filter((li) =>
        li.querySelector('input[inputmode]'),
      );
      // Scroll to the first row before counting. What is being measured is how
      // many goods fit on a screen once you are entering prices -- not how far
      // down the page the list starts, which is what the header and any
      // screenshot-result banner above it decide.
      list[0]?.scrollIntoView({ block: 'start' });
      const vh = window.innerHeight;
      const first = list[0]?.getBoundingClientRect();
      const inputs = [...document.querySelectorAll('input[inputmode]')]
        .slice(0, 6)
        .map((i) => Math.round(i.getBoundingClientRect().height));
      return {
        rowHeight: first ? Math.round(first.height) : null,
        visible: list.filter((r) => {
          const b = r.getBoundingClientRect();
          return b.top < vh && b.bottom > 0;
        }).length,
        screens: Number((document.documentElement.scrollHeight / vh).toFixed(1)),
        smallestInput: inputs.length ? Math.min(...inputs) : 0,
      };
    });
    // Room to breathe, but nowhere near the 202px it started at. The 44px
    // floor is the tap target and must never be traded away for compactness.
    const ok =
      rows.rowHeight !== null &&
      rows.rowHeight <= 120 &&
      rows.visible >= 3 &&
      rows.screens <= 5 &&
      rows.smallestInput >= 44;
    if (ok) {
      pass(
        'the entry sheet stays quick to scroll',
        `${rows.rowHeight}px rows, ${rows.visible} on screen, ${rows.screens} screens, inputs ${rows.smallestInput}px`,
      );
    } else {
      fail(
        'the entry sheet stays quick to scroll',
        `${rows.rowHeight}px rows, ${rows.visible} on screen, ${rows.screens} screens, smallest input ${rows.smallestInput}px`,
      );
    }
  }

  if (pageErrors.length === 0) {
    pass('no uncaught errors in the console');
  } else {
    fail('no uncaught errors in the console', pageErrors.slice(0, 3).join(' | '));
  }
} catch (error) {
  fail('the run completed', error.message);
} finally {
  await browser.close().catch(() => {});
  stopVite();
}

function stopVite() {
  try {
    // Negative pid = the whole group, which is what actually reaches the vite
    // process behind npx.
    process.kill(-vite.pid, 'SIGTERM');
  } catch {
    vite.kill('SIGTERM');
  }
}

// ---------------------------------------------------------------------
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} UI checks passed.`);

if (failed.length > 0) {
  console.log('\nNothing here may be reported to the user as working.');
  // Explicit exit: the Vite child's pipes keep the event loop alive, so
  // without this the script hangs after finishing and looks like a timeout.
  process.exit(1);
}

// The stamp the Stop hook reads. It records WHICH working tree was verified,
// so editing a file afterwards invalidates it rather than silently passing.
// The CONTENT of every source file. `git status` would only capture which
// files are dirty, so editing an already-dirty file would not invalidate this
// stamp -- and "verify, then one more tweak, then report success" is exactly
// the hole this is here to close.
const treeHash = execSync(
  "find src api -type f \\( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \\) -print0 2>/dev/null | sort -z | xargs -0 sha1sum 2>/dev/null | sha1sum | awk '{print $1}'",
  { encoding: 'utf8', shell: '/bin/bash' },
).trim();
writeFileSync(
  '.verified',
  JSON.stringify(
    {
      at: new Date().toISOString(),
      commit: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
      treeHash,
      checks: checks.map((c) => c.name),
    },
    null,
    2,
  ) + '\n',
);
console.log('Wrote .verified');
process.exit(0);
