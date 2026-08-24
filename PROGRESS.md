# PROGRESS

Last updated: 2026-08-24 — Phase 2 complete (session 2). Phase 3 is next.

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
- `src/ui/PortPicker.tsx` → `PortList.tsx` (searchable, the phone default) and
  `PortMap.tsx` (pan, pinch-zoom, clustering, freshness markers).
- `src/ui/ShipPicker.tsx` — presets created from any ship, edited in place, deleted
  behind an inline confirm with an 8-second undo.
- `src/ui/Results.tsx` — plan, four-metric sort, supporting table, return leg,
  unverified caveats, budget gap, and every SPEC 6.6 empty/error state.
- `src/domain/suggest.ts` — "nowhere profitable here, try there" without 41 knapsacks.
- `src/data/queries.ts` — paged reads; PostgREST caps at 1,000 rows and 42 ports of
  61 goods is well past it.

**Not built, by decision:** the settings screen for freshness thresholds (defaults
ship as-is; revisit in Phase 4).

**Unverified at the live URL.** Everything above is proven by tests and a production
build, but nobody has yet loaded the deployed site and clicked through it. That is
the one check this session could not run.

## Next — Phase 3 (Data Entry)

Start in a **fresh session**. SPEC.md section 7. Build manual entry first — it is the
guaranteed path and OCR is only an accelerator (CLAUDE.md rule 6). The results screen
already has an "add data" button wired to `onAddData`, which currently just returns to
the route picker and says outright that entry is not built yet; that is the seam to
pick up.

## Decisions already made — do not re-litigate

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
