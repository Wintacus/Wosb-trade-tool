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
  prices_current: [],
};

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  env: {
    ...process.env,
    VITE_SUPABASE_URL: 'https://verify.invalid',
    VITE_SUPABASE_ANON_KEY: 'verify-only',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let ready = false;
vite.stdout.on('data', (d) => {
  const s = d.toString();
  if (s.includes('ready in') || s.includes('Local:')) ready = true;
});

const started = Date.now();
while (!ready) {
  if (Date.now() - started > 40_000) {
    console.error('Vite did not start.');
    vite.kill('SIGTERM');
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
  if (m.type() === 'error') pageErrors.push(m.text());
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

  if (pageErrors.length === 0) {
    pass('no uncaught errors in the console');
  } else {
    fail('no uncaught errors in the console', pageErrors.slice(0, 3).join(' | '));
  }
} catch (error) {
  fail('the run completed', error.message);
} finally {
  await browser.close().catch(() => {});
  vite.kill('SIGTERM');
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
