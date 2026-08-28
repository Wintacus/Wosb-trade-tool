# PROGRESS

Last updated: 2026-08-28 — Phase 3 COMPLETE and merged to `main` (PR #9), session 4.

Keep this file short. It is loaded into every session and then replayed on every request
inside that session, so narrative history here is paid for hundreds of times. It was 515
lines on 2026-08-28 — roughly 2.2M replayed tokens across a 300-request session — and was
cut back to this. **Record what changes a future decision; delete what is merely
interesting.** Finished bugs belong in commit messages and code comments, not here.

---

## Where the project is

Phases 0–3 are done and live on `main`. **509 tests** across 36 files, **16/16** browser
checks (`npm run verify`), **32/32** touch checks (`node scripts/touch-test.mjs`).

- **Phase 0** — Vite + React + TS + Tailwind v4, deployed. `.env` gitignored from commit 1.
- **Phase 1** — `supabase/schema.sql` (13 tables, `prices_current`, RLS on everything),
  seed with row-count assertions, 115 flagged demo rows, the calculator, all eleven
  SPEC §5.9 tests.
- **Phase 2** — `src/App.tsx` is the product: four-step flow (origin → destination → ship
  → results) as state, not routes. `PortList` + full-screen `PortMap`, `ShipPicker` with
  presets, `Results`, `domain/suggest.ts`, paged reads in `data/queries.ts` (PostgREST
  caps at 1,000 rows; 42 ports × 61 goods is well past it). Diagnostics moved to
  `src/ui/Diagnostics.tsx` (`?diagnostics=1`, footer link).
- **Phase 3** — manual price entry, the invisible contributor account, session
  persistence, and screenshot OCR. Detail below.

**Live:** https://wosb-trade-tool.vercel.app — production builds from `main`.

---

## Blocked / needs a decision

1. **A real screenshot of the Market tab.** OCR is built and switched on, but **how
   accurately it reads a real game screen is unmeasured**: no screenshot exists in the
   repo, so the reading instructions were written against SPEC's *description* of the
   layout rather than a seen one. Pasting one into the chat is enough — Claude reads
   images directly — and it becomes `fixtures/ocr/<name>.png` plus a hand-written
   `.expected.json`, after which `npm run ocr:accuracy` gives a real number.

2. **`ANTHROPIC_API_KEY` — RESOLVED 2026-08-27.** Confirmed set:
   `GET https://wosb-trade-tool.vercel.app/api/ocr` → `{"ready":true,"missing":[]}`.
   That URL is how any session re-checks it; no dashboard, no asking anyone.

---

## Phase 3 — manual entry

- `api/anon-session.ts` mints the invisible contributor account. The database refuses a
  submission from a signed-out visitor (`for insert to authenticated with check
  (submitted_by = auth.uid())`), so an identity is mandatory. Supabase's own
  `signInAnonymously()` needs a dashboard toggle — a manual step for the user — so the
  endpoint creates the user with the service role key and the browser signs in with the
  publishable key. **CONFIRMED END TO END on a real phone 2026-08-26**: the whole chain
  works, and the reserved `.invalid` email domain is fine.
- `src/lib/identity.ts` — credentials in local storage, one in-flight attempt shared by
  concurrent callers, profile row created on first save. Only 400/401/403 destroy the
  credentials; 429 and 408 explicitly do NOT, because "ask again later" is not "you are
  not that account".
- `src/data/submit.ts` — prices parsed from the digits, never by multiplying a float.
  Blank stays unknown, a typed zero is saved, out-of-band warns but saves.
- `src/ui/PriceEntry.tsx` — port → 61 goods in two collapsible sections with search,
  buy/sell/stock per row, sticky save bar.
- **Fields deliberately start empty.** Pre-filling turns Save into re-affirming sixty
  numbers nobody looked at, with a fresh timestamp — laundering a stale price into a
  fresh-looking one. The recorded value sits beside the field instead.
- `src/lib/session.ts` — step, ports, ship and unsaved drafts persist to localStorage and
  restore on load, expiring after 12h. **This is the fix for the worst bug this project
  has shipped** (see Lessons).

## Phase 3 — OCR (SPEC 7.2)

- `api/ocr.ts` — the whole server side. Holds `ANTHROPIC_API_KEY`, calls `claude-opus-5`
  with the image, returns rows for review. **It cannot write to the database.** That is
  how "always show the review screen" is guaranteed: there is no second path to the data,
  so it cannot be forgotten.
- `src/ui/OcrCapture.tsx` fills the same boxes a person types into, marked "read". The
  existing Save button is still the only thing that commits. `GET /api/ocr` reports
  whether the key is configured, so the panel says "switched off" rather than failing on
  upload; Diagnostics shows the same line.
- `src/data/ocr.ts` — resizes to 1568px and re-encodes through a canvas, which is what
  strips EXIF and what converts iPhone HEIC. `applyExtraction` **never overwrites a value
  a person typed**; a field they correct stops counting as machine-read, which is what
  makes `ocr_corrections` mean anything.
- `migrations/0003_ocr_usage.sql` — `ocr_charge()` counts per account in Postgres,
  atomically, 30/hour and 150/day. A refused request still counts. The endpoint **fails
  closed** if the counter is unreachable. An in-memory counter is not good enough here:
  serverless instances do not share memory, and every request spends money.
- Nothing the model returns is trusted: `good_id` is an enum of ids we actually have,
  prices come back as **strings** (a JSON number would put money in a float), anything
  unparseable is dropped with a reason and **never repaired**, duplicates and out-of-band
  values are flagged. The prompt tells the model to transcribe text that reads like an
  instruction rather than follow it.
- `npm run ocr:accuracy` measures real accuracy against `fixtures/ocr/` pairs, importing
  the live prompt and validation rather than copying them. Reports "nothing measured" and
  exits 0 until a fixture exists.

---

## Account creation is rate limited (fixed 2026-08-28)

`/api/anon-session` is unauthenticated by definition — its whole job is handing an
identity to someone who has none — and its only protection was an in-memory counter that
failed two ways at once. Serverless instances do not share memory, so retrying until a
cold instance answered defeated it; and it counted against `X-Forwarded-For`, an ordinary
request header **the caller writes**, so varying it per request made the limit vanish
without even needing a new instance. Every account is a vote in Phase 4's consensus
weighting, so unlimited accounts meant unlimited votes.

- `migrations/0004_anon_session_limits.sql` — `anon_session_charge()`, the same atomic
  Postgres counter proven by `ocr_charge()` in 0003. 10/hour, 50/day. A refused attempt
  still counts. RLS-denied and `service_role`-only.
- `callerAddress()` reads **`x-vercel-forwarded-for`** (written by the platform, which
  overwrites whatever arrived) or `x-real-ip`. It deliberately does **not** fall back to
  `x-forwarded-for`: a value the attacker picks is not an identity, and falling back
  restores the hole exactly when it matters.
- The table stores `subjectFor()` — an **HMAC** of the address keyed with a server-only
  secret, never the address. A bare SHA-256 of an IPv4 address is minutes of brute force.
- **Fails closed.** If the counter cannot be reached, no account is created. A 404 means
  migration 0004 has not applied, which cannot normally happen because migrations run in
  the same build that ships the code — but if it ever does, **new sign-ups stop until it
  is fixed.** That is the deliberate trade: a silently reopened hole is worse.
- Limits are generous because of carrier-grade NAT: a whole mobile network can share one
  address, and refusing an honest contributor is the worse failure. A real person needs
  exactly one account, ever.

**Still open, by design:** there is no origin check. It would only stop other websites'
browsers, not a script, which is the actual threat — the rate limit is the real control.

## What the next session must know

- **The user works from a phone almost always.** A Windows PC with Claude Code exists but
  is rarely to hand — treat it as a fallback, never something to plan around. The product
  is phone-first either way: verify at phone viewport, and reload the page.

- **CONFIRMED IN GAME 2026-08-26 — this shapes the whole product.** The Market tab shows
  **one number per trade good and you can only sell to the port.** There is no buy price
  for a trade good; the user believes they are acquired by looting. So the route planner's
  buy-here-sell-there model **can never recommend a trade good** — it works only on craft
  resources, which do have buy/sell pairs. The entry screen no longer offers a Buy box on
  a trade good but keeps one reachable per row.

- **The "I am holding this, where do I sell it" redesign is BENCHED** (user's call,
  2026-08-26, and a sound one): it needs real data to be worth anything or to test, and it
  would add a second manual chore. **Do not start it without asking.**

- **Screen share (SPEC 7.3) is useless to this user — it is desktop only.** A browser
  cannot capture another app on iOS. When they ask for "just turn on screen sharing and
  autofill", the phone-viable answer is OCR from a screenshot. Say so rather than building
  something they cannot run.

- **Schema changes apply during the Vercel build.** `scripts/apply-migrations.mjs` runs
  `applyPendingChanges()` from `api/_auto.ts`, which calls the database's `apply_migration`
  with `SUPABASE_SERVICE_ROLE_KEY`. **Pushing is the whole workflow — never hand the user
  SQL.** There is no `DATABASE_URL`; `api/migrate.ts` takes the password in a form and uses
  it for one request only. The password bootstrap is done (2026-08-23); the Diagnostics
  page reports the real state — **trust that page over this note.**

- **Generated files:** `supabase/seed.sql`, `supabase/demo_prices.sql`, `api/_sql.ts`,
  `src/lib/migrations.generated.ts`. Edit `scripts/gen-*.mjs`, then `npm run gen:sql`.
  Tests fail if any drifts.

- **`api/` is server-only** — reads `SUPABASE_SERVICE_ROLE_KEY`, pulls in the Postgres
  driver. A test fails if anything under `src/` imports it.

- **Tests run the real `schema.sql` inside PGlite.** Prefer a real Postgres over a mock
  wherever the question is what the database will accept — a mocked fetch answers 200 to a
  request the database refuses. That exact blind spot let 202 tests pass over a missing
  table grant.

- **Prices are integer tenths of gold.** Reference bands in `goods.json` are converted on
  import so they compare like-for-like.

- **`budget.provablyOptimal` / `budget.upperBoundProfit`** — when optimality is not proven,
  show the gap to the ceiling. Median gap 0%, 97% hit the true optimum. Never present an
  unproven plan as optimal. The knapsack runs in 71ms at the largest hold with all 61 goods.

- **A build stamp is in the footer** (`build <sha>`). Two rounds were lost to nobody being
  able to tell whether the phone was showing new code, a cached bundle, or an unfinished
  deploy. Ask the user to read it before debugging anything they report.

- **`.claude/agents/caveman-explore.md`** runs broad repo searches in a side channel and
  returns only `path:line`, keeping file contents out of the conversation. Provenance in
  `.claude/agents/VENDOR.md`. Its companion output-compression skill was vendored and then
  **removed 2026-08-24** — visible replies measured ~7,000 tokens across a whole session,
  so the skill's ~2,100 tokens of instructions cost more than they could save. Do not
  re-add it without new measurements.

### Testing tools

- **`npm run verify`** — drives the real app in real Chromium at phone size, including a
  **page reload**, and writes `.verified`. 16 checks.
- **`node scripts/touch-test.mjs`** — real multi-touch on the real map with the real 42
  ports. 32 checks. `npm i playwright --no-save` first; Chromium is at
  `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. **Take screenshots and LOOK at
  them** — the clipped "Cursed City" label was found no other way. *Its limit:* Chromium
  implements no `gesturestart`, and Playwright's WebKit cannot be downloaded here, so iOS
  Safari page zoom is not covered.
- **The Stop hook** (`.claude/hooks/require-verification.sh`) refuses to end a turn where
  `src/`, `api/`, `supabase/` or `scripts/` changed without a current `.verified`, and
  refuses when a status report is overdue. `scripts/tree-hash.mjs` computes the hash for
  both the hook and the harness so they cannot drift apart.
- **NEVER run `pkill -f vite`.** `pkill -f` matches the shell's own command line, which
  contains the word "vite", so it kills the process about to run the tests. Kill by PID.
  If a run dies with a bare "Vite did not start", an orphaned dev server is holding port
  5199 — `ps -eo pid,args | grep '[v]ite'`.

### What this sandbox can and cannot reach

Raw egress is a tight allowlist: `platform.claude.com`, `registry.npmjs.org`,
`api.anthropic.com`, and github through the git proxy. Everything else —
`api.vercel.com`, `api.supabase.com`, `anthropic.com`, `google.com`, and every
`*.vercel.app` — is refused at CONNECT. **Do not spend calls rediscovering this.**

The **Vercel connector** (claude.ai → Settings → Connectors) routes through the MCP proxy
instead, so it works from here:

- `list_deployments` (build state, and the `branchAlias` for any branch's preview URL),
  `get_deployment_build_logs`, `get_runtime_logs`.
- `web_fetch_vercel_url` **reaches production**. It does **not** reach previews: this
  project has Vercel Authentication on preview deployments, so every preview link 302s to
  an SSO login. That is a project setting, not a bug — the user's own browser is signed
  in, so previews work for them. `get_access_to_vercel_url` mints a 23-hour bypass link,
  but the fetch tool does not follow its cookie redirect.
- There is **no environment-variable tool.** `GET /api/ocr` on production is how a session
  answers "is the key set".

---

## Decisions already made — do not re-litigate

1. **Phase 3 (user, 2026-08-26):** a silent anonymous account rather than email sign-in or
   an open write policy; entry covers trade goods AND craft resources but not port state.
2. **Phase 2 UI (user, 2026-08-24):** ship presets live in this browser's storage only;
   the port picker opens on the searchable list with a tab to the map; the server is asked
   once then changeable from the header; freshness thresholds ship as SPEC defaults with
   no settings screen until Phase 4.
3. **§5.9 test 11** — observed prices in `goods.json` are **sell prices only**. Both ports
   have `buy_price = null`; the expected answer is zero profitable goods both ways.
4. **Demo data** is small and hand-built, not a generated grid.
5. **Tax rounds up**, so quoted profit is never higher than reality.
6. **`port_state_submissions` is append-only**, like `price_submissions`, with
   `port_state_current` resolving each field independently.
7. **Port state entry** (tax %, faction, port level) was NOT in Phase 3's scope.

---

## Lessons already paid for

**The worst bug this project has shipped: the app lost every bit of in-flight work on a
page reload.** Route, ship and every typed price lived only in React state. iOS Safari
discards a backgrounded tab whenever it wants the memory — and this tool's entire workflow
is switching to the game to read a price and switching back. It read as the app resetting
itself at random, which is exactly how the user described it three times *while three
rounds of fixes were aimed at buttons instead.* **No desktop browser ever discards a tab,
so nothing but an explicit reload could have caught it.** `verify-ui.mjs` now reloads.

**Verification is mechanical because writing it down failed twice.** CLAUDE.md hard rule 7
was rewritten from "verify before reporting" to "reproduce the user's symptom before
writing any fix" — the step that was actually missing. The gate enforces it.

**A fixture with no data only ever tests the empty state.** `verify-ui.mjs` had
`prices_current: []`, so every row took the short "not recorded here" branch and the wide
populated row — the only one that breaks — was never drawn. A *verified* build shipped
with every good's name squeezed to 34px. Fixtures now carry the widest shape the UI can
take. (Now also a rule in CLAUDE.md.)

**Both times a phone found something, it was geometry, and both times the fix was to go
measure it in a browser rather than reason about it.** Check UI geometry at the width it
will actually be used at, and put the maths somewhere a test can reach it
(`src/test/map-geometry.test.ts` pins it against the real 42 ports at phone size).

**Never step a gesture from current state.** `zoomTo(scale * ratio)` read `scale` from the
render closure; React batches, so a burst of pointermove events all read the same stale
value — fingers asking ×2.53 got ×1.64 and the anchored port drifted 265px. Pinch is
**absolute** now: distance, scale and the grabbed point captured when the second finger
lands.

**There is no spring-back, so whatever the clamp allows is where the map stays.** Clamping
is per axis against the ports' bounding box, with a constant `EDGE_MARGIN` (= `HIT_RADIUS`,
22px) so a marker's own width cannot draw half outside the viewBox at the clamp's limit.
Locking the non-overflowing axis was tried and is WRONG — it silently overrides the pinch
anchor.

**Four browser-suite checks were themselves wrong**, and were only found by verifying the
app by hand. A check that returns as soon as a port is *merely on screen* is not a check
that a port can be centred. **Verify a failure against the app before believing it.**

**A rising total test count does not prove a test was added** — an edit silently failed to
apply and the count rose anyway from other files. Verify the count in the file you touched.

**Never `git checkout --` a file to undo a test mutation.** It discards uncommitted work on
that file; it ate a real edit on 2026-08-28 during a test *of the verification gate*. Copy
the file aside and copy it back.

**Guard values at the bottom, where every path meets.** A negative buy price once conjured
profit from nothing; fixed with database CHECK constraints, not in the calculator. Mutation
testing separately found an absent column becoming the literal string `"undefined"` and
displaying as a port's controlling faction.

---

## Session cost — read before starting

| Session | Requests | Total tokens | Batching | Median context |
|---|---|---|---|---|
| 1 — Phase 0 + 1 | 390 | 146.8M | 2.0% | 349,208 |
| 2 — Phase 2 | 358 | 111.1M | 0.0% | 325,065 |
| 3 — Phase 3 entry | 62 | 7.7M | 4.6% | 129,884 |
| 4 — Phase 3 OCR | *run `npm run tokens`* | | | |

Session 2 should have been four sessions. Median context per request ran
**132k → 253k → 395k → 507k** across its quarters; the same work at the first quarter's
context would have cost **81M instead of 197M**. Session 3 cost 7.7M for comparable ground
— not through better batching (still 4.6%) but by **ending at the boundary and reading only
what was needed**: SPEC §7 alone, not the whole file.

Two causes, both now rules in CLAUDE.md and both still binding:

1. **Notification wake-ups were 26% of session 2 — 51M tokens over 138 requests, for
   nothing.** 32 wakes from a PR subscription and scheduled check-ins; CI was never once
   red; not one action produced. **Do not call `subscribe_pr_activity`. Do not schedule
   check-ins.** Use the Vercel connector once, on demand, instead.
2. **The session never ended.** End at every real boundary — it is free and it is the
   biggest lever there is.

**Run `npm run tokens` before this session ends and fill in the row above.**

---

## Reference

`SPEC.md` (phased build spec — read only the section you need, it is ~7,900 tokens),
`data/ports.json`, `data/ships.json`, `data/goods.json`, `data/resources.json`
(each has a `_meta` block on provenance — read it before using the data),
`fixtures/ocr/README.md` (how to add a screenshot fixture), `DESIGN_BRIEF.md`.
