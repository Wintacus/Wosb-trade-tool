# PROGRESS

Last updated: 2026-08-26 — Phase 3 manual entry built (session 3). OCR deferred by decision.

Keep this file short. It is loaded into every session and then replayed on every request
inside that session, so narrative history here is paid for hundreds of times. Record what
the next session must know; delete what it merely finds interesting.

## Done

- **Phase 0** — Vite + React + TypeScript + Tailwind v4, deployed, `.env` gitignored from
  the first commit, `.env.example` documents the four variables.
- **Phase 1** — `supabase/schema.sql` (13 tables, `prices_current`, RLS on everything),
  `supabase/seed.sql` with row-count assertions, `supabase/demo_prices.sql` (115 flagged
  demo rows), the calculator, and all eleven SPEC §5.9 tests.
- **289 tests across 20 files, all passing.** Includes RLS verification, secret-leak guards,
  and an end-to-end run against real Postgres.

Phase 1's "Done when" is fully met. Nothing is outstanding on it.

## Done — Phase 2 (Core UI)

Branch `claude/phase-2-6gqs8q`, all pushed. **378 tests passing** (289 from Phase 1).

- `src/App.tsx` **is now the product UI.** The four-step flow (origin → destination →
  ship → results) is state, not routes. Recent routes skip steps 1–2. Swap and reset
  sit beside the picker.
- The Phase 0/1 status page moved to `src/ui/Diagnostics.tsx`, reachable at
  `?diagnostics=1` and from the footer link.
- `src/ui/PortPicker.tsx` → `PortList.tsx` inline (searchable, the phone default) plus
  a button opening `PortMap.tsx` **full screen**.
- `src/ui/ShipPicker.tsx` — presets created from any ship, edited in place, deleted
  behind an inline confirm with an 8-second undo.
- `src/ui/Results.tsx` — plan, four-metric sort, supporting table, return leg,
  unverified caveats, budget gap, and every SPEC 6.6 empty/error state.
- `src/domain/suggest.ts` — "nowhere profitable here, try there" without 41 knapsacks.
- `src/data/queries.ts` — paged reads; PostgREST caps at 1,000 rows and 42 ports of
  61 goods is well past it.

**Not built, by decision:** the settings screen for freshness thresholds (defaults
ship as-is; revisit in Phase 4).

**Map rebuilt after real phone feedback (2026-08-24).** The first version was a desktop
component rendered small, and it had three bugs no test could see because they only
appear at phone width: markers 5px across that *never grew when zoomed* (radius divided
by scale inside a scaled group); panning that tracked the finger at 0.36x–2.9x (CSS
pixels added to an offset consumed as SVG units); and clustering that never fired once
(34-unit threshold below the 54.6-unit closest real port pair, so the numbered-circle
code was dead). The map is now a full-screen layer whose viewBox is measured in CSS
pixels, with pan/zoom applied in JS per marker. `src/test/map-geometry.test.ts` pins all
of it against the real 42 ports at phone size. **Lesson: check UI geometry at the width
it will actually be used at, and put the maths somewhere a test can reach it.**

**Gesture containment.** Pinching the map used to zoom the page and switch apps.
`touch-action` does not stop iOS Safari, which uses its own `gesturestart`/`gesturechange`
events, and React's `onTouchMove` cannot cancel them because React registers touch
listeners passively. Fixed with native `{ passive: false }` listeners scoped to the map
only — never globally, which would break pinch-zoom on text elsewhere. **OS edge-swipe
strips (~20-24px) cannot be reclaimed by any web page**; the map is inset to stay clear.

**There is now a real touch-testing setup — use it.** `npm i -D playwright` (deliberately
not in package.json: CI has no browser and the install would slow every build), then
`node scripts/touch-test.mjs`. It serves `map-harness.html` (dev-server only, never
built into the site), mounts the real map with the real 42 ports, and drives it in
headless Chromium with real multi-touch: tap targets, 1:1 pan tracking, pinch zoom,
edge reachability, label clipping, tap-to-select, cluster-to-zoom. Take screenshots with
it and LOOK at them — the clipped "Cursed City" label was found no other way.
**Its limit:** Chromium implements no `gesturestart`, and Playwright's WebKit cannot be
downloaded here (the proxy blocks its CDN), so iOS Safari page zoom is not covered.

**A user-reported bug the tests all missed, then caught (2026-08-24):** the map could
not be panned right and looked cut off when zoomed. `clampOffset` treated the scaled map
as growing outward from the centre when it actually grows right and down from the
origin, so it permitted half the needed travel; at 5x the furthest port sat 553px past
the edge, unreachable. **Both times a phone found something, it was geometry, and both
times the fix was to go measure it in a browser rather than reason about it.**

**Browser testing: 28/28 passing (2026-08-25).** `scripts/touch-test.mjs` drives the
real map in headless Chromium with real multi-touch. Run it with
`node scripts/touch-test.mjs` (`npm i playwright --no-save` if needed; Chromium is at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`).

**NEVER run `pkill -f vite` in this environment.** `pkill -f` matches the shell's own
command line, which contains the word "vite", so it kills the process about to run the
tests. That produced exit 144 and cost most of a session chasing a suite that was
never broken. Kill by PID, or let the script's own cleanup do it.

Bugs this found, all real, none visible to the 390 unit tests:

1. **Pinch under-zoomed and drifted.** `zoomTo(scale * ratio)` stepped from the previous
   move, reading `scale` from the render closure; React batches, so a burst of
   pointermove events all read the same stale value. Fingers asking ×2.53 gave ×1.64 and
   the anchored port drifted 265px. Pinch is now **absolute** — distance, scale and the
   grabbed point captured when the second finger lands. **Never step a gesture from
   current state.** Confirmed fixed on a real phone by the user.
2. Same fault truncated a drag right after a pinch (72px finger → 24px map).
3. Rotating to landscape while zoomed left a **blank map**; the offset survived a resize
   that changed what was legal. Re-clamped on viewport change.
4. Panning could end on **blank sea**, and an overscroll drag **parked ports outside the
   viewBox for good** — there is no spring-back animation, so whatever the clamp allows
   is where the map stays. Clamping is per axis against the ports' bounding box now:
   overflow → the screen stays inside the content; no overflow → slide within the slack
   only. Locking the non-overflowing axis was tried and is WRONG: it silently overrides
   the pinch anchor.
5. Stale pointer state. `pointerup` does not always arrive for every finger, so a
   gesture killed by a call left panning dead until reload. Cleared when the touch list
   empties.
6. Labels sheared off at the screen edge ("Cursed City" → "ursed City"), found by
   looking at a screenshot.

**Four suite checks were themselves wrong** and were fixed only after verifying the app
by hand: measuring anchor drift on an axis the clamp legitimately pins, dragging at the
fitted view where only ~20px of slack exists, dragging from a marker the zoom had pushed
off screen, and demanding an offset of exactly zero when the real requirement is that no
port is parked outside. Verify a failure against the app before believing it.

**Still unrun:** `scripts/ui-test.mjs` and `app-harness.html` (results screen and ship
presets) were written by a subagent that was cut off. Never executed, never reviewed.

**Unverified at the live URL.** Everything above is proven by tests and a production
build, but nobody has yet loaded the deployed site and clicked through it. That is
the one check this session could not run.

## Session cost — read before starting

| Session | Requests | Total tokens | Batching | Median context |
|---|---|---|---|---|
| 1 — Phase 0 + 1 | 390 | 146.8M | 2.0% | 349,208 |
| 2 — Phase 2 | 358 | 111.1M | 0.0% | 325,065 |

Session 2 should have been four sessions. Median context per request by quarter ran
**132k → 253k → 395k → 507k**; 223 of 613 requests ran above 400k and burned 107M
between them. The same work at the first quarter's context would have cost **81M
instead of 197M**. Two causes, both now rules in CLAUDE.md:

1. **Notification wake-ups: 26% of the session — 51M tokens over 138 requests — for
   nothing.** A PR subscription plus scheduled check-ins meant every Vercel
   "Building"/"Ready" comment edit replayed the whole conversation. 32 wakes, CI never
   once red, not one action produced. Both are now switched off and must stay off.
2. **The session never ended.** End at every real boundary; it is free and it is the
   biggest lever there is.

Run `npm run tokens` before this session ends and add its row above.

## Done — Phase 3 so far (Data Entry)

Branch `claude/phase-3-kickoff-37dj1t`, from a **merged** `main` — PR #6 was merged
2026-08-26, so `main` is now the product UI, not the status page.

**421 tests passing** (390 from Phase 2).

- `api/anon-session.ts` mints the invisible contributor account. The database
  refuses a submission from a signed-out visitor (`for insert to authenticated
  with check (submitted_by = auth.uid())`), so an identity is mandatory before
  anything can be saved. Supabase's own `signInAnonymously()` would do it but is
  off by default and needs a dashboard toggle, which would be a manual step for
  the user — so the endpoint creates the user with the service role key instead,
  and the browser signs itself in with the publishable key.
- `src/lib/identity.ts` — credentials in this browser's local storage, one
  in-flight attempt shared by concurrent callers, profile row created on first
  save (nothing creates it automatically and `submitted_by` is a FK to it).
- `src/data/submit.ts` — parses prices from the digits rather than multiplying a
  float, blank stays unknown, typed zero is saved, out-of-band warns but saves.
- `src/ui/PriceEntry.tsx` — port → 61 goods in two collapsible sections with a
  search, buy/sell/stock per row, sticky save bar. Reachable from the header
  everywhere and from the results screen's "add data" button.

**Fields deliberately start empty.** Pre-filling turns Save into re-affirming
sixty numbers nobody looked at, with a fresh timestamp — laundering a stale
price into a fresh-looking one. The recorded value sits beside the field.

## Next

- **The account-minting path has never run against real Supabase.** It is the
  one part of this that cannot be proven in tests: if `POST /auth/v1/admin/users`
  rejects the reserved `.invalid` email domain, the first save fails with a
  readable error and the fallback is either a real domain or switching on
  anonymous sign-in in the dashboard. Check this first at the live URL.
- **Nothing in Phase 2 or Phase 3 has been clicked through by a person at a
  live URL.** That is still the outstanding check.
- **Open question for the user, asked but not yet answered:** the Market screen
  shows ONE number per trade good (goods.json `_validationEvidence` records 20
  of them at Fiji Bay). Decision 1 below says that number is a SELL price, which
  means no trade good ever has a buy price and the calculator can never produce
  a plan from real trade-good data. The entry screen takes both buy and sell for
  every good so it works either way, but until this is settled, entering trade
  goods may not make the route planner come alive.
- OCR (SPEC 7.2) deferred by the user on 2026-08-26: build manual entry, use it
  on a real port, then decide whether OCR is worth it.
- Port state entry (tax %, faction, port level) is NOT in Phase 3's scope — the
  user chose "prices + craft resources".

## Decisions already made — do not re-litigate

-1. **Phase 3, decided by the user on 2026-08-26:** merge PR #6 before branching;
   a silent anonymous account rather than an email sign-in or an open write
   policy; entry covers trade goods AND craft resources but not port state; OCR
   waits until manual entry has been used on a real port.

0. **Phase 2 UI, decided by the user on 2026-08-24:** ship presets live in this
   browser's storage only (no silent account, nothing to switch on in Supabase);
   the port picker opens on the searchable list with a tab to the map; the server
   is asked once and then changeable from the header; freshness thresholds ship as
   the SPEC defaults with no settings screen until Phase 4.

1. **§5.9 test 11** — observed prices in `goods.json` are **sell prices only**; a Buy control
   has never been seen on a trade good. Both ports have `buy_price = null`; the expected
   answer is zero profitable goods in both directions.
2. **Demo data** — small and hand-built, not a generated grid.
3. **Tax rounds up**, so quoted profit is never higher than reality.
4. **Schema changes apply on deploy.** Never hand the user SQL.
5. **`port_state_submissions` is append-only**, like `price_submissions`, with
   `port_state_current` resolving each field independently. No deviation from SPEC §3.2 remains.

## What the next session must know

- **The user has no local dev environment — phone only.** Never suggest running anything
  locally. Verification happens at the live Vercel URL.
- **Where the live URLs are.** The Vercel project is `wintacus1/wosb-trade-tool`
  (dashboard: https://vercel.com/wintacus1/wosb-trade-tool). Production builds from
  `main`; a branch gets its own preview, and **the Vercel bot posts that preview link
  as a comment on the pull request within a minute or two of opening it**. So the way
  to hand the user a working link for unmerged work is to open the PR and read the
  bot's comment — never ask them for the URL, and never guess at one.
  Phase 2's preview:
  https://wosb-trade-tool-git-claude-phase-2-6gqs8q-wintacus1.vercel.app
- **Schema changes apply during the Vercel build.** `scripts/apply-migrations.mjs` runs
  `applyPendingChanges()` from `api/_auto.ts`, which calls the database's `apply_migration`
  using `SUPABASE_SERVICE_ROLE_KEY`. Pushing is the whole workflow. **There is no
  `DATABASE_URL` in this project** — `api/migrate.ts` takes the password in a form and uses
  it for one request only.
- **The password bootstrap is believed done** (entered 2026-08-23). It installed
  `apply_migration`, which no other credential can create. `schema_state()` now reports
  whether it exists and which migrations have run, and the status page shows it as
  "Database is up to date" — **trust that page over this note.**
- **Generated files:** `supabase/seed.sql`, `supabase/demo_prices.sql`, `api/_sql.ts` and
  `src/lib/migrations.generated.ts`. Edit `scripts/gen-*.mjs`, then `npm run gen:sql`.
  Tests fail if any drifts.
- **`api/` is server-only** — reads `SUPABASE_SERVICE_ROLE_KEY`, pulls in the Postgres driver.
  A test fails if anything under `src/` imports it.
- **Tests run the real `schema.sql` inside PGlite**, so broken SQL fails CI rather than
  surprising the user. Prefer a real Postgres over a mock wherever the question is what the
  database will accept — a mocked fetch answers 200 to a request the database refuses. That
  exact blind spot let 202 tests pass over a missing table grant.
- **Prices are integer tenths of gold.** Reference bands in `goods.json` are converted on
  import so they compare like-for-like.
- **`budget.provablyOptimal` and `budget.upperBoundProfit`** — when optimality is not proven,
  show the gap to the ceiling. Median gap is 0%, 97% hit the true optimum. Never present an
  unproven plan as optimal. The knapsack runs in 71ms at the largest hold with all 61 goods.
- **`.claude/agents/caveman-explore.md`** runs broad repo searches in a side channel and
  returns only `path:line` citations, keeping file contents out of the conversation. It
  targets replayed input, which is 95.6% of spend. Provenance and licence in
  `.claude/agents/VENDOR.md`. Its companion output-compression skill was vendored on
  2026-08-23 and **removed on 2026-08-24** — visible replies measured ~7,000 tokens across
  the whole first session, so the skill's ~2,100 tokens of instructions cost more to carry
  than it could save. Do not re-add it without new measurements.

## Lessons already paid for

- A rising total test count does not prove a test was added — an edit silently failed to
  apply and the count rose anyway from other files. Verify the count in the file you touched.
- Mutation testing found a real bug: an absent database column became the literal string
  `"undefined"` rather than null, and would have displayed as a port's controlling faction.
- A negative buy price once conjured profit from nothing. Fixed at the database with CHECK
  constraints and in the calculator. Guard values at the bottom, where every path meets.
