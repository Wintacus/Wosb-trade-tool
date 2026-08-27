# PROGRESS

Last updated: 2026-08-27 — Phase 3: manual entry + screenshot OCR built (session 4).

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

**A fifth real bug, found on a real iPhone after 28/28 was green (2026-08-26):**
zooming in and panning toward an edge left a port's marker permanently cut in half.
`clampAxis` let a port's own coordinate reach exactly x=0 or x=viewport — the pixel
where the map STOPS — and the marker's constant-radius dot draws half outside the
viewBox at that exact spot, with no further pan able to fix it since that IS the clamp's
limit. Every existing reachability check asserted only the raw coordinate was in
`[0, viewport]`; none rendered the marker, which has real width. Fixed with a constant
`EDGE_MARGIN` (= `HIT_RADIUS`, 22px) the clamp always leaves between a boundary port and
the true edge — `src/ui/PortMap.tsx`'s `clampAxis`/`clampOffset`. Pinned by a new
touch-test check, **29/29 passing**. Reproduced in headless Chromium at zoom as low as
2x; no iOS-only gesture needed, so this was a real, verifiable geometry bug, not the
untestable Safari-gesture gap. Checked and found no issue: the header/footer already pad
for `env(safe-area-inset-top/bottom)` and the map surface is measured after layout via
`getBoundingClientRect()`, so it should already exclude notch/home-indicator space.
**Unchecked gap:** no `safe-area-inset-left/right` padding anywhere in the map — only
matters in landscape on a notched phone, and this Chromium harness cannot simulate a
non-zero safe-area inset to verify it either way.

Also fixed in `scripts/touch-test.mjs` itself: this dev environment can have another
process editing unrelated files in the same working tree while the touch harness runs,
and Vite's file watcher then force-reloads the harness page mid-test, wiping
`window.__probe` and crashing the script. `readMap` now re-installs the probe and
retries on that specific failure — a test-harness robustness fix, not a map bug.

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
| 3 — Phase 3 entry | 62 | 7.7M | 4.6% | 129,884 |

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

Session 3 cost 7.7M against session 2's 111.1M for comparable ground. What
changed was not discipline about batching — that is still 4.6% — but **ending
the session at the boundary and reading only what was needed**: SPEC section 7
alone rather than the whole file, PROGRESS from the branch that was current,
and no PR subscription. Peak context 181k against session 2's 507k.

Run `npm run tokens` before this session ends and add its row above.

## Done — Phase 3 so far (Data Entry)

Branch `claude/phase-3-kickoff-37dj1t`, from a **merged** `main` — PR #6 was merged
2026-08-26, so `main` is now the product UI, not the status page.

**509 tests passing** (390 from Phase 2), plus 15/15 browser checks in `npm run verify`.

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

## Done — Phase 3 OCR (SPEC 7.2)

Screenshot reading is built, tested and deployed. **Whether it reads a real game
screenshot accurately is still unmeasured** — see "Blocked" below. Everything else
about it is verified.

- `api/ocr.ts` — the whole server side. Holds `ANTHROPIC_API_KEY`, calls
  `claude-opus-5` with the image, and returns rows for review. **It cannot write
  to the database.** That is how "always show the review screen" is guaranteed:
  there is no second path to the data, so it cannot be forgotten.
- `src/ui/OcrCapture.tsx` sits at the top of the existing entry sheet and fills
  the same boxes a person types into, marked "read". The existing Save button is
  still the only thing that commits. `GET /api/ocr` reports whether the key is
  configured, so the panel says "switched off" instead of failing on upload, and
  the Diagnostics page shows the same line.
- `src/data/ocr.ts` — resizes to 1568px and re-encodes through a canvas (which is
  what strips EXIF, and what converts iPhone HEIC), then merges the result.
  `applyExtraction` **never overwrites a value a person typed**; a field they
  correct stops counting as machine-read, which is what makes the correction log
  mean anything.
- `migrations/0003_ocr_usage.sql` — `ocr_charge()` counts per account in Postgres,
  atomically. An in-memory counter like the one in `anon-session.ts` is defeated
  by retrying until a cold instance answers, and every request here spends money.
  30/hour, 150/day. A refused request still counts. The endpoint **fails closed**
  if the counter is unreachable.
- Everything the model returns is checked before anyone sees it: `good_id` is an
  enum of ids we actually have, prices are returned as strings (a JSON number
  would put money in a float), anything unparseable is dropped with a reason and
  **never repaired**, duplicates and out-of-band values are flagged. The prompt
  tells the model to transcribe any text that reads like an instruction rather
  than follow it.
- `npm run ocr:accuracy` measures real accuracy against `fixtures/ocr/*` — image
  plus a hand-written `.expected.json`. It imports the live prompt and validation
  rather than copying them. No fixtures and no key yet, so it currently reports
  "nothing measured" and exits 0.

## Blocked / needs the user

- **A real screenshot of the Market tab.** SPEC 7.2 says the layouts were
  "confirmed from real screenshots", but none are in the repo, so the prompt was
  written against a described layout rather than a seen one. One screenshot
  dropped into the chat becomes `fixtures/ocr/` and makes accuracy measurable.
  Until then, nobody knows how well this reads.
- **`ANTHROPIC_API_KEY` in Vercel.** Not confirmed set. This session could not
  check: the sandbox's egress proxy blocks `*.vercel.app`, so the deployed site
  is unreachable from here. The app answers it instead — Diagnostics shows
  "Screenshot reading: ready" or names the missing variable.
  Set it at https://vercel.com/wintacus1/wosb-trade-tool/settings/environment-variables
  (key from https://console.anthropic.com/settings/keys, spend cap at
  https://console.anthropic.com/settings/limits), then redeploy: Vercel applies
  variables only to new deployments.

## Next

- **Eleven defects found by three parallel code reviews on 2026-08-27, all
  reproduced before fixing and all fixed.** The five state bugs are described
  above; these are the rest, and every database rule below was verified against
  real Postgres both ways (broken before, refused after):
  - `migrations/0002_trust_boundaries.sql` — **a future `observed_at` pinned any
    price or tax rate forever**, because `prices_current` orders by it and the
    insert policy never looked at it. Worse on port state: one poisoned row
    containing only `tax_percent` pinned a port's tax at 99%, and tax feeds
    every profit calculation. Freshness is `now - observed_at`, so the poisoned
    value also wore the *freshest* badge. Now `observed_at <= now() + 1 hour`.
  - Same migration — **an all-null row wiped a real price.** `NaN`/`Infinity`
    become JSON `null` on the wire, and `prices_current` takes whole rows by
    timestamp, so a content-free row became the current price. Guarded in the
    database AND in `submitObservations`, which is the door OCR will use.
  - Same migration — `submitted_by` is now `on delete set null`, so an abusive
    contributor can actually be deleted; before, the FK blocked it the moment
    they had contributed. Their honest rows survive unattributed. **The
    append-only triggers had to be taught to allow authorship to be CLEARED but
    never REASSIGNED** — reassignment stays impossible even for an admin.
  - `schema.sql` — **`seasons` let any account `delete` every row.** It was the
    one shared table that was not append-only. Now insert-only + admin.
  - `schema.sql` — `prices_current` had no tie-break, so with two rows sharing
    an `observed_at` the OLDER won and a correction was silently ignored.
    `submitObservations` stamps one timestamp per batch, so ties are ordinary.
  - `identity.ts` — **a network blip silently destroyed the user's account.**
    supabase-js returns `AuthRetryableFetchError` as `{ error }` rather than
    throwing, and the code forgot the credentials on any truthy error. Now only
    400/401/403 count as rejection; 429 and 408 are explicitly NOT, because
    "ask again later" is not "you are not that account".
  - `submit.ts` — parsers capped at 2,147,483,647 (the `integer` column limit);
    before, a "valid" entry was rejected by the column and took the whole batch
    down with a raw Postgres error.
  - `anon-session.ts` — the 8s timeout now covers reading the response body,
    which `fetch` leaves unprotected once headers arrive.
- **Checked and genuinely clean** (verified, not assumed): the service-role key
  cannot reach the browser, `submitted_by` cannot be forged, entries cannot pose
  as demo data, append-only holds at both policy and trigger layers, money never
  touches a float (`parseGold` exact across all 20,010 one-decimal values), and
  `parseSession` survived 31 hostile payloads without throwing.
- **Known and NOT fixed, deliberately:** `/api/anon-session` has no effective
  rate limit — the in-memory limiter is per warm instance, `X-Forwarded-For` is
  client-supplied, and there is no origin check. It costs Supabase MAU and,
  more importantly, means one attacker can mint unlimited "voters", which
  undermines Phase 4's consensus weighting before it is built. Needs a real
  shared limiter (or Vercel's `x-vercel-forwarded-for`) — **decide this before
  building Phase 4 moderation on top of it.**

- **The compaction below then hid every good's NAME, and the check missed it
  for an instructive reason.** The name shared a flex row with the "on record"
  summary; the summary was `shrink-0` and wide ("buy 7.0 · sell 7.0 · stock not
  shown" plus a badge), so the truncating name was squeezed to ~34px. The goods
  list became a column of prices with nothing identifying them. **It passed
  verification because `verify-ui.mjs` had `prices_current: []` — with nothing
  on record, every row took the short "not recorded here" branch and the wide
  one never rendered.** A fixture with no data only ever tests the empty state.
  Fixed by giving the name its own line with `min-w-0`, and the fixture now
  carries a full set of stale, half-demo prices at the port the sheet opens on.
  New check `every good row shows its name` measures the rendered BOX, not the
  text — a zero-width truncated element still has its text in the DOM. Proven
  by restoring the broken version: it failed at 32–34px, passes at 238px.
- **Entry sheet compacted 2026-08-26 — measured, not guessed.** Each good's row
  was **202px** tall, exactly **2 fitted** a 430x740 phone, and the 20 trade
  goods took **6.8 screens** of scrolling (all 61: 15.5). SPEC 7.1 asks this
  screen to be fast on a phone and it was not. The height was pure repetition:
  a "Never recorded here" badge sitting above an "On record: nothing yet" line
  saying the same thing, "Sell you get"/"Stock if shown" labels spelled out on
  all 61 rows, and one identical "shows a buy price? Add one" offer per row.
  Now: badge carries freshness alone, "on record" shows only when something is,
  labels are placeholders with `sr-only` text behind them, and the buy-price
  offer is one section-level toggle instead of twenty. Result **92px rows, 4 on
  screen, 3.8 screens** (all 61: 9.3), inputs still 44px. Pinned by `the entry
  sheet stays quick to scroll` in verify-ui.mjs.
- **DECIDED 2026-08-26: the "where do I sell my hold" redesign is BENCHED.**
  User's call and a sound one — it needs real data to be worth anything or to
  test, and it would add a second manual chore (entering your hold). Revisit
  once there is data. **Do not start it without asking.**
- **OCR is greenlit but NOT next.** User chose to polish and use manual entry
  first, and confirmed they will set `ANTHROPIC_API_KEY` in Vercel with a spend
  cap when we get there. Scope when it starts: **Market screen only** (the 20
  trade goods), review screen mandatory, per SPEC 7.2's safeguards. The
  `ocr_corrections` table already exists from Phase 1; no OCR code exists yet.
- **Screen share (SPEC 7.3) is useless to this user — it is desktop only.** The
  browser cannot capture another app on iOS. When they ask for "just turn on
  screen sharing and autofill", the phone-viable answer is OCR from a
  screenshot, not 7.3. Say so rather than building something they cannot run.
- **Phase 3 merged to `main` as PR #7 on 2026-08-26.** Production carries manual
  entry, the silent account, session persistence, the map fixes, the build
  stamp and the verification gate. Phase 3 remains OPEN for OCR only.

- **THE bug, found 2026-08-26 after three wrong diagnoses: the app lost every
  bit of in-flight work on a page reload.** Route, ship and every typed price
  lived only in React state. iOS Safari discards a backgrounded tab whenever it
  wants the memory — and this tool's entire workflow is switching to the game to
  read a price and switching back. So the app appeared to reset itself at
  random, which is exactly how the user described it three times ("it wipes
  everything... and then it just resets again") while three rounds of fixes
  were aimed at buttons instead. Fixed by `src/lib/session.ts`: step, ports,
  ship and unsaved drafts persist to localStorage on every change and restore
  on load, expiring after 12h so a stale route is not resumed the next day.
  **No desktop browser ever discards a tab, so nothing but an explicit reload
  could have caught this.** `scripts/verify-ui.mjs` now reloads.
- **Verification is mechanical now, because writing it down failed twice.**
  `npm run verify` drives the real app in real Chromium at phone size — the
  four-step flow, a reload, the Add-prices path, typed prices surviving a
  reload — and writes `.verified` with a hash of every source file's contents.
  The `Stop` hook in `.claude/settings.json` refuses to end a turn where
  `src/` or `api/` changed without a matching `.verified`, so "verified, then
  one more tweak, then reported success" is now blocked rather than discouraged.
  Add a check to that script for every new symptom found. CLAUDE.md hard rule 7
  was rewritten from "verify before reporting" to "reproduce the user's symptom
  before writing any fix", which is the step that was actually missing.
- **A build stamp is in the footer** (`build <sha>`, from
  `VERCEL_GIT_COMMIT_SHA`). Two rounds were lost to nobody being able to tell
  whether the phone was showing new code, a cached bundle, or an unfinished
  deploy. Ask the user to read it before debugging anything they report.
- **CONFIRMED WORKING END TO END on a real phone, 2026-08-26.** The user
  entered a price at Al-Khalif and saw "Saved 1 observation". That single
  screenshot proves the whole chain the tests could not: `/api/anon-session`
  minting a real Supabase user with the reserved `.invalid` email domain, the
  browser signing in with it, the profile row being created, and the RLS
  insert into `price_submissions` being accepted. **This was the biggest open
  unknown in Phase 3 and it is closed.** The `.invalid` domain is fine; no
  fallback to a real domain or to dashboard anonymous sign-in is needed.
- **CONFIRMED IN GAME 2026-08-26:** the Market tab shows ONE number per trade
  good and **you can only sell to the port** — there is no buy price for a
  trade good, and the user believes they are acquired by looting. The route
  planner's buy-here-sell-there model therefore can never recommend a trade
  good; it works only on craft resources, which do have buy/sell pairs. The
  entry screen no longer offers a Buy box on a trade good but keeps one
  reachable per row. **Agreed with the user: redesign toward "I am holding
  this, where do I sell it" — not started, and explicitly to be done step by
  step after the current bugs are confirmed fixed live.**
- **Map pan room, fixed 2026-08-26 (user-reported, third map round).** The
  clamp stopped panning at edge-meets-edge, pinning the outermost port
  EDGE_MARGIN px from the screen edge with no pan left to improve it — on
  screen, but with its label running off and its marker under the zoom
  controls. Measured before the fix: extremes stopped 161–320px from centre.
  `clampAxis` now blends from the resting limits toward "either outermost port
  can reach the middle of the screen", phased in by `panFreedom(scale)` — 0 at
  the fitted view (so the map still sits still there; loosening it flat broke
  the overscroll check immediately) and 1 by 2x zoom. **Two wrong turns worth
  not repeating:** ramping on content span rather than zoom is aspect-ratio
  dependent and left the vertical axis 24px short; and loosening only the
  larger-than-screen branch missed that a tall phone letterboxes the map, so
  the vertical axis is still "smaller than the screen" even at 2x. Both
  branches now share one ramp. Pinned by a new check, `an edge port can be
  panned near the middle of the screen`, which FAILED before the fix — and
  which had to be rewritten to use `panToLimit` rather than `panToward`,
  because panToward returns as soon as a port is merely on screen, the exact
  inadequate bar the check exists to replace. 31/31 touch checks.
- **Zoom controls no longer hide ports (2026-08-26).** Measured first: the
  stack covered a 48x148px block of a 406x580px map (3%) and sat on top of
  Port Bord Radel at the fitted view. Chosen by the user from three options:
  ⟲ reset moved to the header beside ✕ (rare action, was holding prime
  bottom-right space over the map), and the remaining +/− fade to opacity 0.2
  with `pointer-events-none` while a finger is down, returning on lift — so
  they are transparent exactly when something is being dragged into view, and
  a faded button cannot swallow a tap meant for the port behind it. +/− stay
  ON the map deliberately: they are the gesture-free path for anyone who
  cannot pinch. Pinned by `the zoom controls fade while dragging and come back
  after`. 32/32 touch checks.
- OCR (SPEC 7.2) still deferred until manual entry has been used on a real port.
- Port state entry (tax %, faction, port level) is NOT in Phase 3's scope.

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
