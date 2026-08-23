# PROGRESS

Last updated: 2026-08-23 — Phase 0 and Phase 1 COMPLETE and verified against the live database

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

## Verified live

The user ran `/api/migrate` on 2026-08-23 and it reported green: connected via
pooler us-west-2, schema and security applied, reference data and demo prices
loaded, all row counts matching, row-level security enabled on every table.

**Phase 1's "Done when" is therefore fully met.** Nothing is outstanding on it.

## Next (Phase 2 — Core UI)

Phase 1 is done, so Phase 2 may begin.

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
4. **Schema application** — automated via `/api/migrate`. The user never pastes SQL,
   never copies a connection string, and sets no environment variables for it.

## Things the next session should know

- The user has **no local dev environment** — phone only. Never suggest running a command
  locally. Everything is verified at the live Vercel URL or in the GitHub Actions tab.
- Claude sessions have **no Supabase credentials**, but that does NOT mean handing the user
  SQL. `/api/migrate` runs on Vercel where `DATABASE_URL` lives, so schema changes are applied
  by pushing and tapping the endpoint.
- `supabase/seed.sql`, `supabase/demo_prices.sql` and `api/_sql.ts` are **generated**. Edit
  `scripts/gen-*.mjs` and run `npm run gen:sql`. Tests fail if any of them drifts.
- `api/` is server-only: it reads `DATABASE_URL` and `ADMIN_TOKEN` and pulls in the Postgres
  driver. A test fails if anything under `src/` imports it, which would bundle all of that
  into the browser.
- Tests run the **real** `schema.sql` inside PGlite (Postgres compiled to WebAssembly), so a
  broken SQL file fails CI rather than surprising the user in the dashboard.
- **There is no longer any deviation from SPEC.md §3.2.** `port_state_submissions` is
  append-only like `price_submissions`, and `port_state_current` resolves each field
  independently so correcting a port's tax cannot erase its shallow-water limit. Demo port
  rows carry `is_demo` and are displaced by the first real observation.
- **Reference price bands are stored in tenths of gold**, converted from the whole gold in
  `goods.json`, so they compare like-for-like against submitted prices.
- The gold-limited cargo solver reports `budget.provablyOptimal` and
  `budget.upperBoundProfit`. When optimality is not proven, show the gap to the ceiling
  rather than either claiming it is best or implying it is bad — measured over 300 random
  cases the median gap is 0% and 97% land on the true optimum. Never present an unproven
  plan as optimal.
- Two open offers the user has not answered: installing a migration function callable by
  the service role key, so future schema changes need no password at all; and whether the
  append-only `port_state` redesign is what they want (it was built after they dismissed
  the question, and flagged at the time).
