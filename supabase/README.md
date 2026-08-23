# Database setup

Three files, run **in this order** in the Supabase SQL Editor
(Dashboard → SQL Editor → New query → paste → Run).

| Order | File | What it does | Required? |
|---|---|---|---|
| 1 | `schema.sql` | Creates every table, the `prices_current` view, and turns on row-level security with all its policies | Yes |
| 2 | `seed.sql` | Loads 42 ports, 38 ships, 61 goods and 20 upgrades from `data/*.json` | Yes |
| 3 | `demo_prices.sql` | Loads a small set of clearly-labelled fake prices so the calculator has something to chew on | Optional |

All three are safe to run more than once.

**Row-level security (RLS)** is the Postgres feature that checks a rule on
every single row before anyone can read or write it. It matters here because
the browser talks to the database directly using the publishable key, so the
database itself — not the app — has to be the thing that says no.

Each file ends with assertions. If a count is wrong the script raises an error
and the whole thing rolls back, so a half-finished import cannot pass quietly.
Look for a `Seed OK: …` or `Demo OK: …` notice to confirm success.

## Making yourself an admin

Reference tables (ports, ships, goods, upgrades, servers) are read by everyone
but written only by admins. Nobody is an admin until you say so. In the SQL
Editor, once you have signed in to the app at least once:

```sql
insert into admins (user_id) values ('<your auth user uuid>');
```

Find that uuid under Authentication → Users in the Supabase dashboard.

## Checking RLS really works

SPEC.md §3.2 asks for this to be verified rather than assumed. The automated
test suite does it against a real Postgres instance on every push — see
`src/test/rls.test.ts`. To check by hand, sign in as one user, create a ship
preset, then sign in as a second user and try to read it. You should get zero
rows, not an error.
