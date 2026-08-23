# Database setup

**You do not run these files by hand.** Open `/api/migrate` on the deployed
site, type your Supabase database password, and it applies all three, verifies
the result and shows you what it did.

The files are here because they are the source of truth for the schema, and
because they are embedded into that endpoint at build time.

| File | What it does | Required? |
|---|---|---|
| `schema.sql` | Every table, both views, and row-level security with all its policies | Yes |
| `seed.sql` | 42 ports, 38 ships, 61 goods and 20 upgrades from `data/*.json` | Yes |
| `demo_prices.sql` | A small set of clearly-labelled fake prices | Optional |

`seed.sql` and `demo_prices.sql` are **generated** — edit `scripts/gen-*.mjs`
and run `npm run gen:sql`. A test fails if the committed SQL drifts from its
generator, or from the copy embedded in the endpoint.

All three are safe to run more than once: the schema creates objects only if
absent, the seed upserts, and the demo data replaces only rows already flagged
as demo.

**Row-level security (RLS)** is the Postgres feature that checks a rule on
every single row before anyone can read or write it. It matters here because
the browser talks to the database directly using the publishable key, so the
database itself — not the app — has to be the thing that says no.

## Two append-only tables

`price_submissions` and `port_state_submissions` are never updated or deleted.
Corrections are new rows. That is what makes the history usable for consensus
weighting and outlier detection later, and it means nobody can quietly rewrite
what someone else recorded.

Each has a companion view that resolves the current answer:

- `prices_current` — newest unflagged submission per (server, port, good)
- `port_state_current` — newest value **per field**, so correcting a port's tax
  does not erase a shallow-water limit somebody recorded last week

Both drop demo rows for a port as soon as any real submission exists for it.

## Making yourself an admin

Reference tables are read by everyone but written only by admins, and nobody
is an admin until you say so. In the Supabase SQL Editor, once you have signed
in to the app at least once:

```sql
insert into admins (user_id) values ('<your auth user uuid>');
```

Find that uuid under Authentication → Users.

## Checking RLS really works

The test suite does it on every push against a real Postgres — see
`src/test/rls.test.ts`, which includes the cross-account read SPEC.md §3.2
asks for. The deployed site also probes it live from the browser.
