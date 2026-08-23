# PROGRESS

Last updated: 2026-08-23 — Phase 0 + Phase 1 build session

## Done
- [x] Phase 0: Vite + React + TypeScript scaffold, Tailwind v4, production build verified
- [x] `.gitignore` excludes `.env` from the very first commit; `.env.example` documents the four vars

## In progress
- Phase 1: nothing yet beyond the scaffold

## Next
- `supabase/schema.sql` — tables, indexes, `prices_current` view, RLS on every table
- `supabase/seed.sql` — generated from `data/*.json` (42 ports, 38 ships, 61 goods, 20 upgrades)
- `supabase/demo_prices.sql` — small hand-built demo set
- Calculator engine (money, rate gating, distance, effective ship stats, knapsack)
- The eleven tests from SPEC.md §5.9

## Blocked / needs the user
- Nothing blocking right now.

## Notes for the next session
- The user has NO local dev environment — phone only. Everything is verified at
  https://wosb-trade-tool.vercel.app or in GitHub Actions. Never suggest running a command locally.
- Claude sessions have no Supabase credentials. Schema and seed ship as SQL files the
  user pastes into the Supabase web SQL Editor by hand. Do not try to connect to Supabase.
- Decisions the user made in the Phase 0/1 session, so they are not re-litigated:
  1. §5.9 test 11 — the observed prices in `goods.json` `_validationEvidence` are treated as
     **sell prices only** (a Buy control has never been seen on trade goods). Both ports therefore
     have `buy_price = null`, so every good is excluded for "no buy price at origin" and the
     expected answer is zero profitable goods in *both* directions.
  2. Demo data — small and hand-built (a few ports), not a generated full grid.
  3. Tax rounding — tax rounds **up**, so quoted profit is never higher than reality.
  4. Schema is applied by the user pasting SQL into the Supabase SQL Editor.
