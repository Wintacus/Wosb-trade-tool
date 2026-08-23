# Migrations

Changes to the schema that came **after** the original `schema.sql`.

`schema.sql` is idempotent — it creates objects only if they are absent — so
re-running it picks up new tables, views and policies. What it cannot do is
alter something that already exists: adding a column to a live table, changing
a type, backfilling data. Those go here.

## Rules

- Name files `NNNN_short_description.sql`, numbered in order.
- **Each file must be safe to run twice.** Use `if not exists`, `if exists`,
  and guard data changes with a `where` clause that makes a second run a no-op.
  The runner records what it has applied, but belt and braces costs nothing.
- Never edit a file after it has been applied. Its checksum is recorded, and a
  changed file is reported rather than silently re-run.

## How they run

`/api/migrate?auto=1` applies anything not yet recorded in `schema_migrations`,
using the service role key that already lives in Vercel. No password, and
nothing for anyone to do by hand.
