# WOSB Trade Tool

An unofficial fan-made trading calculator for **World of Sea Battle**. Pick an origin port,
a destination and a ship, and it works out which cargo to fill the hold with to make the most
gold.

Not affiliated with, endorsed by, or connected to the game's developers.

## Status

| Phase | State |
|---|---|
| 0 — Setup | Complete |
| 1 — Data and calculator | Complete, pending the SQL being run against Supabase |
| 2 — Core UI | Not started |

There is deliberately no interface yet. SPEC.md builds the calculator and proves it with tests
before anything visual, because the maths is the product and it is far easier to verify against
known inputs than through a browser.

## Setting up the database

Run the three files in [`supabase/`](supabase/) in order, in the Supabase SQL Editor. See
[`supabase/README.md`](supabase/README.md) for the details. Each file checks its own row counts
and stops rather than importing half the data.

Once they have run, the deployed URL shows a live checklist of the setup: connection, all seven
seed counts, whether a logged-out visitor can reach any private table, and whether any
server-only key leaked into the browser bundle.

## Repository layout

| Path | What it holds |
|---|---|
| `data/*.json` | Source of truth for game data, with provenance and confidence notes |
| `supabase/` | Schema, row-level security, and generated seed SQL |
| `scripts/` | Generators that turn `data/*.json` into SQL |
| `src/domain/` | The calculator: money, distance, rate gating, ship stats, knapsack |
| `src/data/` | Database rows to domain objects |
| `src/test/` | Tests, including all eleven required by SPEC.md §5.9 |
| `SPEC.md` | The full build specification |
| `CLAUDE.md` | Project conventions |
| `PROGRESS.md` | Session handover notes |

## Tests

`npm test` runs them; CI runs them on every push, so results are visible in the repository's
Actions tab. The database tests execute the real `supabase/schema.sql` inside PGlite (Postgres
compiled to WebAssembly), so a broken SQL file fails CI rather than failing in the dashboard.

## Ground rules

Four are worth knowing before changing anything:

- **Never invent game data.** A `null` means unknown. Unknown tax is not 8% just because 8% is
  common — observed rates run from 4% to 12%.
- **Nothing game-derived is hardcoded.** The game is in Early Access and actively patched, so
  ship stats, tax rates and port ownership all live in the database and are user-editable.
- **Money is integers**, stored as tenths of gold. No float ever represents currency.
- **Secrets never reach the browser.** Only `VITE_`-prefixed variables are bundled into client
  code, so nothing secret may carry that prefix.

The rest are in [CLAUDE.md](CLAUDE.md).
