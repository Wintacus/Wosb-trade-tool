# PROGRESS

Last updated: 2026-08-23 — Phase 0 and Phase 1 complete, on branch `claude/phase-0-1-setup-bm5cwq`

## Done

- [x] **Phase 0** — Vite + React + TypeScript + Tailwind v4, production build verified,
      `.env` gitignored from the first commit, `.env.example` documents the four variables.
- [x] **Phase 1 — schema** — `supabase/schema.sql`: all 13 tables, `prices_current` view,
      row-level security on every table with the policies from SPEC.md §3.2.
- [x] **Phase 1 — seed** — `supabase/seed.sql`, generated from `data/*.json`, with row-count
      assertions that roll the import back if anything is short.
- [x] **Phase 1 — demo data** — `supabase/demo_prices.sql`, 115 clearly-flagged demo rows.
- [x] **Phase 1 — calculator** — money, rate gating, distance, effective ship stats, exact
      bounded knapsack, four metrics, return leg, optional gold limit.
- [x] **Phase 1 — tests** — all eleven from SPEC.md §5.9, plus RLS verification, secret-leak
      guards and an end-to-end run. 121 assertions, all passing.

## Waiting on the user

**The SQL has not been run against the real Supabase project yet.** Claude sessions have no
Supabase credentials, so this is the one step that cannot be done from here. In the Supabase
dashboard → SQL Editor, run in order:

1. `supabase/schema.sql`
2. `supabase/seed.sql`
3. `supabase/demo_prices.sql` (optional)

Then open `wosb-trade-tool.vercel.app` — the page runs the Phase 1 checks live and will show
green or tell you exactly what is missing.

## Next (Phase 2 — Core UI)

Do not start until the checks on the live URL are green.

- Four-step flow: origin → destination → ship → results
- Map of the 42 ports with pan/zoom, **plus a searchable text list as an equal alternative**
- Freshness indicator: colour AND icon AND text label, never colour alone
- Results screen with the four sort metrics and the full supporting table
- Ship presets, editable in place, upgrades optional
- Every empty and error state from SPEC.md §6.6
- Replace `src/App.tsx` entirely — it is a status page, not product UI

## Decisions already made — do not re-litigate

1. **§5.9 test 11** — the observed prices in `goods.json` `_validationEvidence` are **sell
   prices only**; a Buy control has never been seen on a trade good. Both ports therefore have
   `buy_price = null` and the expected answer is zero profitable goods in both directions.
2. **Demo data** — small and hand-built, not a generated full grid.
3. **Tax rounding** — tax rounds **up**, so quoted profit is never higher than reality.
4. **Schema application** — the user pastes SQL into the Supabase SQL Editor by hand.

## Things the next session should know

- The user has **no local dev environment** — phone only. Never suggest running a command
  locally. Everything is verified at the live Vercel URL or in the GitHub Actions tab.
- Claude sessions have **no Supabase credentials**. Do not try to connect. Schema changes ship
  as SQL files for the user to run.
- `supabase/seed.sql` and `supabase/demo_prices.sql` are **generated**. Edit
  `scripts/gen-sql.mjs` / `scripts/gen-demo-sql.mjs` and run `npm run gen:sql`. A test fails
  if the committed SQL drifts from its generator.
- Tests run the **real** `schema.sql` inside PGlite (Postgres compiled to WebAssembly), so a
  broken SQL file fails CI rather than surprising the user in the dashboard.
- **One deliberate deviation from SPEC.md §3.2**, commented in `schema.sql`: `port_state`
  allows authenticated UPDATE, not insert-only. It holds one row per (port, server) and ships
  as all-nulls, so insert-only would let the first person to touch a port fix its tax forever.
- **Reference price bands are stored in tenths of gold**, converted from the whole gold in
  `goods.json`, so they compare like-for-like against submitted prices.
- The gold-limited cargo solver is exact when it can prove it and says so via
  `budget.provablyOptimal`. When it cannot prove optimality it still never returns an
  unaffordable plan. Do not present an unproven plan as optimal in the UI.
