/**
 * GENERATED FILE. Do not edit by hand: run `npm run gen:sql`.
 *
 * The contents of supabase/*.sql, embedded so the serverless migrate endpoint
 * carries them in its own bundle rather than reading from disk.
 */

export const schemaSql = `-- =====================================================================
-- WOSB Trade Tool -- schema, indexes, prices_current view, and RLS.
--
-- Run this FIRST, in the Supabase SQL Editor (Dashboard -> SQL Editor ->
-- New query -> paste -> Run). Then run seed.sql, then demo_prices.sql.
--
-- Safe to re-run: every object is created with "if not exists" or dropped
-- first, so running it twice does not destroy data.
--
-- "RLS" below means row-level security: Postgres checks a per-row rule on
-- every read and write, so the browser key cannot reach rows it should not
-- see even though the browser talks to the database directly.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Admin identification
--
-- Several tables are writable by admins only. Membership lives in its own
-- table rather than a column on profiles, so that a policy on profiles
-- never has to read profiles (which would recurse).
--
-- This table has RLS on and NO policies, so nobody reaches it through the
-- API at all. Add yourself with the SQL Editor, which runs as the owner:
--   insert into admins (user_id) values ('<your-auth-user-uuid>');
-- ---------------------------------------------------------------------
create table if not exists admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now()
);

-- security definer: runs as the function owner, so it can read \`admins\`
-- even though the caller cannot.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;

-- ---------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------

-- Server regions are SEPARATE ECONOMIES. This is not cosmetic: a price from
-- the EU server is meaningless on NA.
create table if not exists servers (
  id   text primary key,
  name text not null
);

create table if not exists profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  server_id    text references servers(id),
  faction_id   text,
  created_at   timestamptz not null default now()
);

-- Static reference data, seeded from JSON. Global across servers.
create table if not exists goods (
  id            text primary key,
  name          text not null,
  weight        integer not null,
  base_value    integer,
  min_price     integer,
  max_price     integer,
  is_trade_good boolean not null,
  perishable    boolean not null default false,
  category      text,
  -- A weightless good would let an unlimited quantity into any hold.
  constraint goods_weight_positive check (weight > 0),
  constraint goods_base_nonneg     check (base_value is null or base_value >= 0),
  constraint goods_min_nonneg      check (min_price  is null or min_price  >= 0),
  constraint goods_max_nonneg      check (max_price  is null or max_price  >= 0)
);

create table if not exists ships (
  id              text primary key,
  name            text not null,
  class           text not null,
  hull_type       text,
  rate            integer not null,
  durability      integer,
  speed           numeric,
  maneuverability integer,
  armor           numeric,
  hold            integer not null,
  crew            integer,
  upgrade_slots   integer,
  verified        boolean not null default true,
  constraint ships_rate_range    check (rate >= 1 and rate <= 7),
  constraint ships_hold_positive check (hold > 0)
);

create table if not exists upgrades (
  id                   text primary key,
  name                 text not null,
  category             text,
  hold_flat            integer default 0,
  hold_percent         numeric default 0,
  speed_flat           numeric default 0,
  speed_percent        numeric default 0,
  cruise_speed_flat    numeric default 0,
  durability_flat      integer default 0,
  durability_percent   numeric default 0,
  upgrade_slots_flat   integer default 0,
  prevents_spoilage    boolean default false
);

-- Ports: static identity here, per-server observed state in port_state_submissions.
create table if not exists ports (
  id           text primary key,
  name         text not null,
  display_name text,
  x            integer not null,
  y            integer not null,
  category     text
);

-- Per-server port state -- APPEND ONLY, exactly like price_submissions.
--
-- SPEC.md 3.2 says corrections to shared data are new rows, never edits. An
-- earlier draft made this one mutable row per (port, server), which broke that
-- rule: whoever recorded a port's tax first owned it, and there was no history.
-- Guild capture changes a port's owner and tax constantly, so history is the
-- interesting part, not an overhead.
--
-- Every column except the port and server is nullable because every one of
-- them is genuinely unknown until somebody observes it. A submission that
-- records only the tax leaves the rest null, and the view below keeps the last
-- known value of each field separately rather than blanking the others.
create table if not exists port_state_submissions (
  id                  bigserial primary key,
  server_id           text not null references servers(id),
  port_id             text not null references ports(id),
  tax_percent         numeric,   -- null = UNKNOWN. Do not default to 8.
  docking_fee         integer,   -- null = UNKNOWN, treated as 0. UNVERIFIED.
  min_ship_rate       integer,   -- e.g. 6 means only rates 6-7 may dock
  controlling_faction text,
  port_level          integer,
  port_type           text,      -- 'city' | 'settlement'
  has_market          boolean,   -- null = unobserved, not "no market"
  -- SET NULL: see price_submissions. A contributor must remain deletable.
  submitted_by        uuid references profiles(id) on delete set null,   -- null for demo rows
  source              text not null default 'manual', -- manual | ocr | demo
  is_demo             boolean not null default false,
  observed_at         timestamptz not null default now(),
  flagged             boolean not null default false,
  flag_reason         text,
  constraint port_tax_range      check (tax_percent is null or (tax_percent >= 0 and tax_percent <= 100)),
  constraint port_fee_nonneg     check (docking_fee is null or docking_fee >= 0),
  constraint port_min_rate_range check (min_ship_rate is null or (min_ship_rate >= 1 and min_ship_rate <= 7)),
  constraint port_level_nonneg   check (port_level is null or port_level >= 0),
  -- port_state_current resolves each column independently by observed_at, so
  -- one future-dated row containing only tax_percent pins that port's tax rate
  -- permanently -- and tax feeds every profit calculation. See migrations/0002.
  constraint port_state_observed_not_future
    check (observed_at <= now() + interval '1 hour')
);

create index if not exists port_state_lookup_idx
  on port_state_submissions (server_id, port_id, observed_at desc);

-- The port state the calculator should actually use.
--
-- Each FIELD is resolved independently: the newest submission that actually
-- recorded a value for it wins. That matters because someone correcting a
-- port's tax should not wipe out a shallow-water limit another player recorded
-- last week, which a plain "newest row wins" rule would do.
--
-- Demo rows follow the same rule as prices: ignored for a port as soon as any
-- real submission exists for it.
--
-- array_agg with \`(field is null)\` first in the ordering puts rows that have a
-- value ahead of rows that do not, then takes the newest of those.
drop view if exists port_state_current;
create view port_state_current with (security_invoker = true) as
with live as (
  select
    ps.*,
    exists (
      select 1 from port_state_submissions r
      where r.server_id = ps.server_id
        and r.port_id   = ps.port_id
        and not r.is_demo
        and not r.flagged
    ) as real_exists
  from port_state_submissions ps
  where not ps.flagged
)
select
  server_id,
  port_id,
  (array_agg(tax_percent order by (tax_percent is null), observed_at desc))[1]
    as tax_percent,
  (array_agg(docking_fee order by (docking_fee is null), observed_at desc))[1]
    as docking_fee,
  (array_agg(min_ship_rate order by (min_ship_rate is null), observed_at desc))[1]
    as min_ship_rate,
  (array_agg(controlling_faction order by (controlling_faction is null), observed_at desc))[1]
    as controlling_faction,
  (array_agg(port_level order by (port_level is null), observed_at desc))[1]
    as port_level,
  (array_agg(port_type order by (port_type is null), observed_at desc))[1]
    as port_type,
  (array_agg(has_market order by (has_market is null), observed_at desc))[1]
    as has_market,
  max(observed_at) as observed_at,
  -- Demo rows are dropped entirely once a real one exists, so a port is
  -- either all demo or all real here.
  bool_or(is_demo) as is_demo
from live
where not is_demo or not real_exists
group by server_id, port_id;

-- ---------------------------------------------------------------------
-- Price submissions -- APPEND ONLY
--
-- Every submission is kept as its own row; nothing is overwritten. This is
-- required, not optional:
--   * Phase 4 consensus weighting needs multiple submissions to compare
--   * outlier detection needs to see disagreement between contributors
--   * price history needs the time series
-- A single overwritten row per port/good would make all three impossible.
-- ---------------------------------------------------------------------
create table if not exists price_submissions (
  id           bigserial primary key,
  server_id    text not null references servers(id),
  port_id      text not null references ports(id),
  good_id      text not null references goods(id),
  buy_price    integer,   -- tenths of gold, integer
  sell_price   integer,
  stock        integer,   -- null if the game does not show a quantity
  -- SET NULL so an abusive contributor can actually be deleted: without it the
  -- delete is blocked the moment they have submitted anything. Their rows
  -- survive unattributed rather than being destroyed with them.
  submitted_by uuid references profiles(id) on delete set null,   -- null for demo rows
  source       text not null default 'manual', -- manual | ocr | screenshare | demo
  is_demo      boolean not null default false,
  observed_at  timestamptz not null default now(),
  flagged      boolean not null default false,
  flag_reason  text,
  -- Money and quantities can be unknown, but never negative. A negative buy
  -- price would read as free money to the profit arithmetic.
  constraint price_buy_nonneg   check (buy_price  is null or buy_price  >= 0),
  constraint price_sell_nonneg  check (sell_price is null or sell_price >= 0),
  constraint price_stock_nonneg check (stock      is null or stock      >= 0),
  -- A row dated in the future wins prices_current forever, because that view
  -- orders by observed_at. An hour absorbs phone clock skew; more would be
  -- useful only to someone pinning a price. See migrations/0002.
  constraint price_observed_not_future check (observed_at <= now() + interval '1 hour'),
  -- NaN and Infinity become JSON null on the wire, producing a content-free
  -- row that would otherwise become the current price and destroy a real one.
  constraint price_has_some_value
    check (buy_price is not null or sell_price is not null or stock is not null)
);

create index if not exists price_submissions_lookup_idx
  on price_submissions (server_id, port_id, good_id, observed_at desc);

-- Fast lookup of the price the calculator should actually use.
-- Rules:
--   * ignore flagged rows
--   * ignore demo rows for a (port, good) once ANY real submission exists
--   * otherwise take the most recent
-- Phase 4 swaps this selection logic for consensus weighting without changing
-- the calculator's interface.
--
-- security_invoker makes the view respect the caller's RLS rather than the
-- view owner's, so it can never become a way around row-level security.
drop view if exists prices_current;
create view prices_current with (security_invoker = true) as
select distinct on (server_id, port_id, good_id)
  server_id, port_id, good_id, buy_price, sell_price, stock,
  observed_at, is_demo, source
from price_submissions ps
where not flagged
  and (
    not is_demo
    or not exists (
      select 1 from price_submissions r
      where r.server_id = ps.server_id
        and r.port_id   = ps.port_id
        and r.good_id   = ps.good_id
        and not r.is_demo
        and not r.flagged
    )
  )
-- \`id desc\` is the tie-break, and it is not cosmetic: submitObservations
-- stamps ONE observed_at across a whole batch and accepts a caller-supplied
-- one, so two rows sharing a timestamp are ordinary. Without it the OLDER row
-- won -- verified, consistently -- so a correction re-submitted with the same
-- timestamp was silently ignored.
order by server_id, port_id, good_id, observed_at desc, id desc;

-- ---------------------------------------------------------------------
-- Per-user data
-- ---------------------------------------------------------------------
create table if not exists ship_presets (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles(id) on delete cascade,
  name        text not null,
  ship_id     text not null references ships(id),
  upgrade_ids text[] not null default '{}',  -- may be empty: barebones is valid
  created_at  timestamptz not null default now()
);
create index if not exists ship_presets_profile_idx on ship_presets (profile_id);

create table if not exists saved_routes (
  id                  uuid primary key default gen_random_uuid(),
  profile_id          uuid not null references profiles(id) on delete cascade,
  origin_port_id      text references ports(id),
  destination_port_id text references ports(id),
  label               text,
  last_used_at        timestamptz not null default now()
);
create index if not exists saved_routes_profile_idx on saved_routes (profile_id);

-- Records what OCR read vs what a human corrected it to.
-- Structured fields ONLY -- never store the source image.
create table if not exists ocr_corrections (
  id              bigserial primary key,
  screen_type     text,   -- market | shipyard | port_tooltip
  field_name      text,
  ocr_value       text,
  corrected_value text,
  created_at      timestamptz not null default now()
);

-- Seasonal world modifiers. Cannot be predicted; recorded when observed.
create table if not exists seasons (
  id        bigserial primary key,
  server_id text references servers(id),
  name      text,
  starts_at timestamptz,
  ends_at   timestamptz,
  modifiers jsonb,
  active    boolean not null default false
);

-- ---------------------------------------------------------------------
-- Self-applying schema changes
--
-- Once this exists, schema updates no longer need the database password.
-- The deployed site holds the service role key already, and can ask the
-- database to apply a change through the function below.
--
-- What this costs, stated plainly: the service role key already reads and
-- writes every row in the database, bypassing row-level security entirely.
-- This adds the ability to CHANGE THE SCHEMA to whatever holds that key. It
-- is a real widening of what a leaked key could do. The key lives only in
-- Vercel's server-side environment and never reaches the browser -- a test
-- fails the build if it ever could.
--
-- The function is locked to service_role alone: anon and authenticated
-- cannot execute it, so nothing reachable from a browser can call it.
-- ---------------------------------------------------------------------
create table if not exists schema_migrations (
  name       text primary key,
  checksum   text not null,
  applied_at timestamptz not null default now()
);

create or replace function public.apply_migration(migration_sql text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  execute migration_sql;
end $$;

-- Locked down deliberately. security definer means this runs with the
-- owner's rights, so who may CALL it is the only thing standing in the way.
revoke all on function public.apply_migration(text) from public;
do $grant$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.apply_migration(text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.apply_migration(text) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.apply_migration(text) to service_role';
  end if;
end $grant$;

alter table schema_migrations enable row level security;
-- No policies, so nothing reachable from a browser sees it. The service role
-- bypasses row-level security, but bypassing RLS is not the same as having a
-- table grant, and both gates have to be open.
--
-- Supabase's default privileges would probably cover this on their own. This
-- schema revokes and re-grants everything else explicitly rather than trusting
-- those defaults, and leaving one table to luck is how a feature works in
-- testing and fails the first time it matters.
do $sm_grant$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on schema_migrations to service_role';
    execute 'grant usage, select on all sequences in schema public to service_role';
  end if;
end $sm_grant$;

-- ---------------------------------------------------------------------
-- schema_state(): is the database actually up to date?
--
-- The status page had no way to answer this. It could prove the tables and
-- seed rows exist, but not whether the automatic migration path is alive or
-- which migrations have landed -- and those are exactly what silently stop
-- working. \`scripts/apply-migrations.mjs\` never fails a build on purpose, so
-- a broken migration path looks like a perfectly normal deployment.
--
-- security definer because \`schema_migrations\` deliberately has no policies
-- and is unreadable from a browser. This exposes migration NAMES and times
-- only, never their SQL and never the checksums. The schema is a public file
-- in a public repository, so the names give nothing away; being able to see
-- that the database is behind is worth considerably more.
--
-- Note what its ABSENCE means. This function ships in the same file as
-- apply_migration, so if the status page reports it missing, the schema has
-- not been re-applied since this was written -- which is itself the answer.
-- ---------------------------------------------------------------------
create or replace function public.schema_state()
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'auto_migrations_ready',
    exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'apply_migration'
    ),
    'applied_count', (select count(*) from schema_migrations),
    'applied', coalesce(
      (
        select json_agg(json_build_object('name', name, 'applied_at', applied_at)
                        order by name)
        from schema_migrations
      ),
      '[]'::json
    )
  );
$$;

-- Readable by everyone: it reports state, changes nothing, and the status page
-- runs in the browser with the publishable key.
do $ss_grant$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.schema_state() to anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.schema_state() to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.schema_state() to service_role';
  end if;
end $ss_grant$;

-- =====================================================================
-- Row level security
--
-- Enabled on EVERY table. A table with RLS on and no matching policy
-- returns zero rows and rejects writes.
--
-- The service_role key bypasses all of this by design, which is exactly
-- why it must never reach the browser.
-- =====================================================================

alter table admins            enable row level security;
alter table servers           enable row level security;
alter table profiles          enable row level security;
alter table goods             enable row level security;
alter table ships             enable row level security;
alter table upgrades          enable row level security;
alter table ports             enable row level security;
alter table port_state_submissions enable row level security;
alter table price_submissions enable row level security;
alter table ship_presets      enable row level security;
alter table saved_routes      enable row level security;
alter table ocr_corrections   enable row level security;
alter table seasons           enable row level security;

-- \`admins\` deliberately gets no policies at all: unreachable through the API.

-- ---------------------------------------------------------------------
-- Reference tables: everyone reads, admins write.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['servers', 'goods', 'ships', 'upgrades', 'ports'] loop
    execute format('drop policy if exists %I on %I', t || '_read_all', t);
    execute format('drop policy if exists %I on %I', t || '_write_admin', t);
    execute format(
      'create policy %I on %I for select using (true)', t || '_read_all', t);
    execute format(
      'create policy %I on %I for all to authenticated using (public.is_admin()) with check (public.is_admin())',
      t || '_write_admin', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- profiles: own row only, both directions.
-- ---------------------------------------------------------------------
drop policy if exists profiles_read_own   on profiles;
drop policy if exists profiles_insert_own on profiles;
drop policy if exists profiles_update_own on profiles;
drop policy if exists profiles_delete_own on profiles;

create policy profiles_read_own on profiles
  for select to authenticated using (id = auth.uid());
create policy profiles_insert_own on profiles
  for insert to authenticated with check (id = auth.uid());
create policy profiles_update_own on profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_delete_own on profiles
  for delete to authenticated using (id = auth.uid());

-- ---------------------------------------------------------------------
-- price_submissions: shared community data.
-- Everyone reads. Authenticated users insert. NOBODY updates or deletes --
-- corrections are new rows, which is what makes the history trustworthy.
-- Admins may update, and a trigger below limits them to the flag columns.
-- ---------------------------------------------------------------------
drop policy if exists price_submissions_read_all      on price_submissions;
drop policy if exists price_submissions_insert_authed on price_submissions;
drop policy if exists price_submissions_flag_admin    on price_submissions;

create policy price_submissions_read_all on price_submissions
  for select using (true);

-- submitted_by must be the caller: a user cannot post prices as someone else.
create policy price_submissions_insert_authed on price_submissions
  for insert to authenticated
  with check (submitted_by = auth.uid() and is_demo = false and source <> 'demo');

create policy price_submissions_flag_admin on price_submissions
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- No delete policy anywhere: the table cannot be deleted from through the API.

create or replace function public.price_submissions_flag_only()
returns trigger
language plpgsql
as $$
begin
  -- The foreign key's ON DELETE SET NULL must be able to unattribute a row
  -- when a contributor is removed, and that is an UPDATE, so the append-only
  -- rule below would otherwise block the delete entirely -- which is the bug
  -- this is paired with. Clearing authorship is the ONLY change permitted
  -- here: setting submitted_by to a DIFFERENT user would be forging it, which
  -- the insert policy exists to prevent and must stay impossible afterwards.
  if new.submitted_by is distinct from old.submitted_by
     and new.submitted_by is not null
  then
    raise exception
      'price_submissions.submitted_by may only be cleared, never reassigned';
  end if;

  if (new.id, new.server_id, new.port_id, new.good_id, new.buy_price,
      new.sell_price, new.stock, new.source, new.is_demo,
      new.observed_at)
     is distinct from
     (old.id, old.server_id, old.port_id, old.good_id, old.buy_price,
      old.sell_price, old.stock, old.source, old.is_demo,
      old.observed_at)
  then
    raise exception
      'price_submissions is append-only; only flagged/flag_reason may be updated';
  end if;
  return new;
end $$;

drop trigger if exists price_submissions_flag_only_trg on price_submissions;
create trigger price_submissions_flag_only_trg
  before update on price_submissions
  for each row execute function public.price_submissions_flag_only();

-- ---------------------------------------------------------------------
-- port_state_submissions: shared world state, append-only.
--
-- Same rules as price_submissions, for the same reason. Anyone logged in may
-- record what they saw at a port; nobody edits or deletes what anyone else
-- recorded. Guild capture changes port ownership and tax constantly, so the
-- history of who saw what and when is the valuable part.
-- ---------------------------------------------------------------------
drop policy if exists port_state_read_all      on port_state_submissions;
drop policy if exists port_state_insert_authed on port_state_submissions;
drop policy if exists port_state_flag_admin    on port_state_submissions;

create policy port_state_read_all on port_state_submissions
  for select using (true);

-- submitted_by must be the caller, and nobody may pass their own observation
-- off as seeded demo data.
create policy port_state_insert_authed on port_state_submissions
  for insert to authenticated
  with check (submitted_by = auth.uid() and is_demo = false and source <> 'demo');

create policy port_state_flag_admin on port_state_submissions
  for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- No delete policy: the table cannot be deleted from through the API.

create or replace function public.port_state_flag_only()
returns trigger
language plpgsql
as $$
begin
  -- See price_submissions_flag_only: ON DELETE SET NULL must be able to clear
  -- authorship, and only clear it. Reassignment stays impossible.
  if new.submitted_by is distinct from old.submitted_by
     and new.submitted_by is not null
  then
    raise exception
      'port_state_submissions.submitted_by may only be cleared, never reassigned';
  end if;

  if (new.id, new.server_id, new.port_id, new.tax_percent, new.docking_fee,
      new.min_ship_rate, new.controlling_faction, new.port_level,
      new.port_type, new.has_market, new.source,
      new.is_demo, new.observed_at)
     is distinct from
     (old.id, old.server_id, old.port_id, old.tax_percent, old.docking_fee,
      old.min_ship_rate, old.controlling_faction, old.port_level,
      old.port_type, old.has_market, old.source,
      old.is_demo, old.observed_at)
  then
    raise exception
      'port_state_submissions is append-only; only flagged/flag_reason may be updated';
  end if;
  return new;
end $$;

drop trigger if exists port_state_flag_only_trg on port_state_submissions;
create trigger port_state_flag_only_trg
  before update on port_state_submissions
  for each row execute function public.port_state_flag_only();

-- ---------------------------------------------------------------------
-- ship_presets and saved_routes: own rows only.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['ship_presets', 'saved_routes'] loop
    execute format('drop policy if exists %I on %I', t || '_own', t);
    execute format(
      'create policy %I on %I for all to authenticated using (profile_id = auth.uid()) with check (profile_id = auth.uid())',
      t || '_own', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- seasons: shared world state, any authenticated user may record one.
--
-- This was \`for all ... using (true) with check (true)\` plus a delete grant,
-- which meant any account could empty the table. Verified: an ordinary
-- contributor ran \`delete from seasons\` and removed every row. Since
-- /api/anon-session hands an authenticated account to anyone who asks, that
-- was "anyone on the internet can delete all seasonal data".
--
-- Every other shared table here is append-only with admin correction. This one
-- was the exception, for no reason anybody recorded.
-- ---------------------------------------------------------------------
drop policy if exists seasons_read_all     on seasons;
drop policy if exists seasons_write_authed on seasons;
drop policy if exists seasons_insert_authed on seasons;
drop policy if exists seasons_admin        on seasons;

create policy seasons_read_all on seasons for select using (true);
create policy seasons_insert_authed on seasons
  for insert to authenticated with check (true);
create policy seasons_admin on seasons
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- ocr_corrections: admins read, any authenticated user inserts.
-- Never contains images -- structured fields only.
-- ---------------------------------------------------------------------
drop policy if exists ocr_corrections_read_admin   on ocr_corrections;
drop policy if exists ocr_corrections_insert_authed on ocr_corrections;

create policy ocr_corrections_read_admin on ocr_corrections
  for select to authenticated using (public.is_admin());
create policy ocr_corrections_insert_authed on ocr_corrections
  for insert to authenticated with check (true);

-- ---------------------------------------------------------------------
-- Grants.
--
-- Grants and RLS are two different gates and BOTH have to be open. A grant
-- decides whether a role may touch a table at all; RLS then decides which
-- rows. A missing grant shows up as "permission denied", a failing policy
-- as zero rows.
--
-- Everything is revoked first and then granted back explicitly. Supabase
-- adds default privileges to new tables in \`public\`, so without the revoke
-- this schema would inherit whatever those defaults happen to be rather
-- than saying what it means.
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant usage on schema public to anon, authenticated;

-- Public reads: reference data, plus the shared community data.
grant select on servers, goods, ships, upgrades, ports,
                port_state_submissions, port_state_current,
                price_submissions, seasons, prices_current
  to anon, authenticated;

-- Reference tables: the grant opens the door for logged-in users, and the
-- admin-only policies above are what actually keep non-admins out.
grant insert, update, delete on servers, goods, ships, upgrades, ports
  to authenticated;

-- Community data. update on price_submissions is narrowed to admins by
-- policy, and further narrowed to the flag columns by the trigger.
grant insert, update on price_submissions to authenticated;
grant insert, update on port_state_submissions to authenticated;

-- OCR corrections: anyone logged in may add one; the select policy means
-- only admins actually get rows back.
grant select, insert on ocr_corrections to authenticated;

-- Per-user data. Policies restrict every one of these to the owner's rows.
grant select, insert, update, delete on profiles, ship_presets, saved_routes
  to authenticated;
-- Insert only: correcting or removing a season is an admin action, and the
-- policy above is what allows it. A delete grant here is what let any account
-- empty the table.
grant select, insert on seasons to authenticated;

-- Needed for the bigserial id columns on inserts.
grant usage, select on all sequences in schema public to authenticated;

-- admins is reachable by nobody but the service role and the SQL Editor.
revoke all on admins from anon, authenticated;

-- ---------------------------------------------------------------------
-- Tell PostgREST to reload.
--
-- It caches the database's shape, so a function created a moment ago is
-- invisible to the REST API until it refreshes -- which would make the first
-- automatic update fail with a baffling 404. Supabase reloads on DDL by
-- itself, but saying so explicitly costs nothing and removes the race.
-- ---------------------------------------------------------------------
do $reload$
begin
  notify pgrst, 'reload schema';
exception when others then
  -- Not running under PostgREST (a plain Postgres, or a test). Nothing to do.
  null;
end $reload$;
`;

export const seedSql = `-- =====================================================================
-- WOSB Trade Tool -- seed data.
--
-- GENERATED FILE. Do not edit by hand: run \`npm run gen:sql\` instead.
-- Source of truth is data/*.json, which carries the provenance and
-- confidence notes for every value.
--
-- Run this AFTER schema.sql, in the Supabase SQL Editor.
-- Safe to re-run: every insert upserts (inserts if new, updates if the id
-- already exists), and the assertions at the end re-check the row counts.
--
-- Money note: base_value, min_price and max_price are stored in TENTHS of
-- gold, matching price_submissions. The JSON holds whole gold, so those
-- three columns are multiplied by 10 here. Weights are untouched.
-- =====================================================================

-- Server regions are separate economies; prices never cross between them.
insert into servers (id, name) values
  ('na', 'North America'),
  ('eu', 'Europe'),
  ('ru', 'Russia'),
  ('asia', 'Asia')
on conflict (id) do update set name = excluded.name;

-- 42 ports. Coordinates are map pixels, meaningful only
-- as relative distance. Tax, docking fee, min ship rate, owner and level are
-- deliberately NOT seeded: they live in port_state_submissions, change with
-- every guild capture, and are unknown until a player observes them.
insert into ports (id, name, display_name, x, y, category) values
  ('assab', 'Assab', 'Assab', 97, 1211, 'k'),
  ('cursed_city', 'Cursed City', 'Cursed City', 101, 636, 'n'),
  ('al_khalif', 'Al-Khalif', 'Al-Khalif', 110, 1393, 'k'),
  ('nisogora', 'Nisogora', 'Nisogora', 166, 434, 'n'),
  ('nordberg', 'Nordberg', 'Nordberg', 217, 301, 'f'),
  ('west_bastion', 'West Bastion', 'West Bastion', 214, 818, 'n'),
  ('sharhat', 'Sharhat', 'Sharhat', 290, 1105, 'k'),
  ('oneg', 'Oneg', 'Oneg', 341, 121, 'n'),
  ('naabad_stronghold', 'Naabad Stronghold', 'Naabad Stronghold', 403, 676, 'p'),
  ('gelbion', 'Gelbion', 'Gelbion', 483, 342, 'n'),
  ('masadora', 'Masadora', 'Masadora', 499, 829, 'n'),
  ('devios', 'Devios', 'Devios', 540, 1177, 'n'),
  ('el_tigre', 'El Tigre', 'El Tigre', 552, 1364, 'f'),
  ('surako', 'Surako', 'Surako', 553, 529, 'f'),
  ('corsa_nois_bay', 'Corsa-Nois Bay', 'Corsa-Nois Bay', 672, 102, 'p'),
  ('bridgetown', 'Bridgetown', 'Bridgetown', 730, 836, 'n'),
  ('san_cristobel', 'San Cristobel', 'San Cristobel', 751, 1350, 'n'),
  ('charleston', 'Charleston', 'Charleston', 763, 986, 'n'),
  ('nevis', 'Nevis', 'Nevis', 826, 539, 'n'),
  ('pirate_city', 'Pirate City', 'Pirate City', 843, 1419, 'p'),
  ('everston', 'Everston', 'Everston', 867, 232, 'n'),
  ('laguna_blanco', 'Laguna Blanco', 'Laguna Blanco', 975, 969, 'n'),
  ('aruba', 'Aruba', 'Aruba', 1083, 354, 'n'),
  ('san_martinas', 'San Martinas', 'San Martinas', 1089, 1375, 'n'),
  ('tortuga', 'Tortuga', 'Tortuga', 1129, 771, 'p'),
  ('la_navidad', 'La Navidad', 'La Navidad', 1244, 918, 'n'),
  ('thermopylae', 'Thermopylae', 'Thermopylae', 1260, 617, 'n'),
  ('aldansk', 'Aldansk', 'Aldansk', 1274, 133, 'f'),
  ('south_bastion', 'South Bastion', 'South Bastion', 1297, 1287, 'n'),
  ('gray_island', 'Gray Island', 'Gray Island', 1343, 403, 'n'),
  ('st_john', 'St. John', 'St. Jean Bay', 1375, 1016, 'f'),
  ('fiji', 'Fiji', 'Fiji Bay', 1454, 747, 'n'),
  ('severoangelsk', 'Severoangelsk', 'Severoangelsk', 1463, 140, 'n'),
  ('bord_radel', 'Bord Radel', 'Port Bord Radel', 1528, 1400, 'n'),
  ('north_bastion', 'North Bastion', 'North Bastion', 1553, 355, 'n'),
  ('los_catuano', 'Los Catuano', 'Los Catuano Bay', 1582, 1162, 'n'),
  ('brandport', 'Brandport', 'Brandport Bay', 1641, 664, 'f'),
  ('santa_maria', 'Santa Maria', 'Santa Marta', 1716, 1021, 'f'),
  ('northside', 'Northside', 'Northside Cove', 1718, 201, 'n'),
  ('puerto_salada', 'Puerto Salada', 'Puerto Salada Bay', 1739, 1232, 'n'),
  ('freebooter_bay', 'Freebooter Bay', 'Freebooter Bay', 1763, 835, 'p'),
  ('freedom_bay', 'Freedom Bay', 'Freedom Bay', 1769, 508, 'f')
on conflict (id) do update set
  name = excluded.name, display_name = excluded.display_name,
  x = excluded.x, y = excluded.y, category = excluded.category;

-- 38 ships, transcribed from in-game shipyard stat cards.
-- speed is BASE speed: the game HUD shows base..maxCruise and cards show base.
-- upgrade_slots is null where it was not visible on the card -- null means
-- unknown, not zero.
insert into ships (id, name, class, hull_type, rate, durability, speed,
                   maneuverability, armor, hold, crew, upgrade_slots, verified) values
  ('huracan', 'Huracan', 'Imperial', 'Ship of the Line', 1, 8000, 5.5, 42, 11.5, 54000, 288, null, true),
  ('la_royale', 'La Royale', 'Siege', 'Galley', 1, 2900, 7.4, 83, 6.5, 24000, 156, null, true),
  ('12_apostolov', '12 Apostolov', 'Heavy', 'Ship of the Line', 1, 4400, 6.2, 49, 10, 36000, 220, null, true),
  ('la_couronne', 'La Couronne', 'Transport', 'Galleon', 1, 3500, 7.6, 72, 5.5, 50000, 188, null, true),
  ('victory', 'Victory', 'Battle', 'Ship of the Line', 1, 3740, 7.1, 66, 8, 25000, 204, null, true),
  ('octopus', 'Octopus', 'Imperial', 'Ship', 2, 2760, 8.3, 75, 6.8, 23000, 176, null, true),
  ('adventure', 'Adventure', 'Siege', 'Galley', 2, 2660, 8.2, 92, 5.2, 21000, 140, null, true),
  ('redoutable', 'Redoutable', 'Heavy', 'Ship of the Line', 2, 3540, 7, 57, 8, 30500, 198, null, true),
  ('la_sirene', 'La Sirene', 'Transport', 'Ship', 2, 2660, 8.1, 80, 4.4, 43000, 170, null, true),
  ('sans_pareil', 'Sans Pareil', 'Battle', 'Ship of the Line', 2, 3000, 7.7, 74, 6.4, 21500, 184, null, true),
  ('ingermanland', 'Ingermanland', 'Fast', 'Ship of the Line', 2, 2340, 9, 87, 3.2, 17500, 152, null, true),
  ('deadfish', 'Deadfish', 'Imperial', 'Ship', 3, 3000, 6.6, 66, 8, 27000, 166, null, true),
  ('kobukson', 'Kobukson', 'Siege', 'Phanokson', 3, 2000, 8, 85, 4.6, 18000, 124, null, true),
  ('bellona', 'Bellona', 'Heavy', 'Ship of the Line', 3, 3180, 7.5, 62, 7, 26000, 174, null, true),
  ('mordaunt', 'Mordaunt', 'Transport', 'Ship of the Line', 3, 2380, 8.7, 87, 3.9, 34000, 148, null, true),
  ('anson', 'Anson', 'Battle', 'Ship of the Line', 3, 2700, 8.2, 80, 5.6, 18500, 160, null, true),
  ('poltava', 'Poltava', 'Fast', 'Ship of the Line', 3, 2100, 9.6, 95, 2.8, 15500, 132, null, true),
  ('devourer', 'Devourer', 'Imperial', 'Barque', 4, 1760, 7.5, 110, 5.5, 17000, 144, null, true),
  ('constitution', 'Constitution', 'Heavy', 'Frigate', 4, 2560, 8, 68, 6, 21500, 148, null, true),
  ('falmouth', 'Falmouth', 'Transport', 'Ship', 4, 1920, 9.4, 96, 3.3, 27500, 126, null, true),
  ('essex', 'Essex', 'Battle', 'Frigate', 4, 2160, 8.9, 88, 4.8, 15500, 136, null, true),
  ('surprise', 'Surprise', 'Fast', 'Corvette', 4, 1680, 10.5, 105, 2.4, 13000, 112, null, true),
  ('black_prince', 'Black Prince', 'Imperial', 'Galleon', 5, 1700, 9.9, 90, 3, 14500, 120, null, true),
  ('le_requin', 'Le Requin', 'Siege', 'Xebec', 5, 1520, 9.6, 105, 3.2, 12500, 88, null, true),
  ('san_martin', 'San Martin', 'Heavy', 'Galleon', 5, 2140, 8.5, 72, 5, 17500, 126, null, true),
  ('russia', 'Russia', 'Transport', 'Frigate', 5, 1600, 9.9, 91, 2.7, 22000, 108, 8, true),
  ('black_wind', 'Black Wind', 'Battle', 'Frigate', 5, 1820, 9.4, 84, 4, 13000, 116, null, true),
  ('la_creole', 'La Creole', 'Fast', 'Corvette', 5, 1400, 11, 100, 2, 11000, 96, null, true),
  ('balloon', 'Balloon', 'Imperial', 'Montgolfiere', 6, 200, 21, 50, 1, 1000, 8, null, true),
  ('golden_apostle', 'Golden Apostle', 'Siege', 'Unknown', 6, 900, 9.5, 120, 2.2, 8500, 96, null, true),
  ('phoenix', 'Phoenix', 'Heavy', 'Brig', 6, 1380, 8.2, 75, 4.5, 12500, 104, null, true),
  ('polacca', 'Polacca', 'Siege', 'Polacca', 6, 980, 9, 102, 2.9, 9000, 74, 6, true),
  ('mercury', 'Mercury', 'Transport', 'Galleon', 6, 1040, 9.2, 89, 2.5, 15500, 88, null, true),
  ('la_salamandre', 'La Salamandre', 'Battle', 'Ketch', 6, 1160, 8.8, 82, 3.6, 9500, 96, null, true),
  ('le_cerf', 'Le Cerf', 'Fast', 'Cutter', 6, 900, 10, 97, 1.8, 8000, 78, 8, true),
  ('friede', 'Friede', 'Transport', 'Flute', 7, 750, 8.8, 86, 2.2, 11000, 72, 6, true),
  ('horizont', 'Horizont', 'Battle', 'Brigantine', 7, 850, 8.4, 80, 3.2, 7000, 78, 6, true),
  ('pickle', 'Pickle', 'Fast', 'Schooner', 7, 700, 9.2, 94, 1.6, 6000, 66, 6, true)
on conflict (id) do update set
  name = excluded.name, class = excluded.class, hull_type = excluded.hull_type,
  rate = excluded.rate, durability = excluded.durability, speed = excluded.speed,
  maneuverability = excluded.maneuverability, armor = excluded.armor,
  hold = excluded.hold, crew = excluded.crew,
  upgrade_slots = excluded.upgrade_slots, verified = excluded.verified;

-- 61 goods total: 20 trade goods
-- (is_trade_good = true) plus 26 craft materials and
-- 15 special items (is_trade_good = false).
-- min_price/max_price exist only for the 20 trade goods, where a price band
-- was actually observed. They are a sanity check on submissions, never a price.
insert into goods (id, name, weight, base_value, min_price, max_price,
                   is_trade_good, perishable, category) values
  ('beer', 'Beer', 6, 50, 50, 90, true, false, null),
  ('dates', 'Dates', 6, 80, 80, 140, true, false, null),
  ('grog', 'Grog', 5, 90, 90, 160, true, false, null),
  ('nuts', 'Nuts', 5, 90, 90, 160, true, false, null),
  ('wine', 'Wine', 3, 90, 90, 160, true, false, null),
  ('mango', 'Mango', 4, 110, 110, 190, true, false, null),
  ('pineapples', 'Pineapples', 4, 110, 110, 190, true, false, null),
  ('oil', 'Oil', 3, 130, 130, 220, true, false, null),
  ('paprika', 'Paprika', 9, 150, 150, 260, true, false, null),
  ('salt', 'Salt', 5, 180, 180, 310, true, false, null),
  ('leather', 'Leather', 5, 200, 200, 340, true, false, null),
  ('pepper', 'Pepper', 6, 210, 210, 360, true, false, null),
  ('vanilla', 'Vanilla', 7, 220, 220, 380, true, false, null),
  ('cinnamon', 'Cinnamon', 7, 230, 230, 390, true, false, null),
  ('rugs', 'Rugs', 6, 240, 240, 410, true, false, null),
  ('coffee', 'Coffee', 12, 250, 250, 430, true, false, null),
  ('sugar', 'Sugar', 20, 300, 300, 510, true, false, null),
  ('tobacco', 'Tobacco', 14, 320, 320, 550, true, false, null),
  ('saffron', 'Saffron', 15, 370, 370, 630, true, false, null),
  ('silk', 'Silk', 20, 520, 520, 880, true, false, null),
  ('wood', 'Wood', 2, 20, null, null, false, false, 'raw'),
  ('fabric', 'Fabric', 1, 30, null, null, false, false, 'processed'),
  ('iron', 'Iron', 4, 30, null, null, false, false, 'metal'),
  ('iron_ore', 'Iron Ore', 6, 30, null, null, false, false, 'ore'),
  ('water', 'Water', 2, 30, null, null, false, false, 'raw'),
  ('fresh_meat', 'Fresh Meat', 5, 40, null, null, false, true, 'food'),
  ('wreckage', 'Wreckage', 5, 50, null, null, false, false, 'raw'),
  ('fish', 'Fish', 3, 60, null, null, false, true, 'food'),
  ('rum', 'Rum', 6, 80, null, null, false, false, 'processed'),
  ('grain', 'Grain', 20, 80, null, null, false, true, 'food'),
  ('coal', 'Coal', 5, 100, null, null, false, false, 'raw'),
  ('whale_oil', 'Whale Oil', 15, 100, null, null, false, false, 'raw'),
  ('tackles', 'Tackles', 5, 120, null, null, false, false, 'processed'),
  ('animals', 'Animals', 22, 120, null, null, false, false, 'food'),
  ('supplies', 'Supplies', 5, 150, null, null, false, true, 'food'),
  ('copper_ore', 'Copper Ore', 25, 200, null, null, false, false, 'ore'),
  ('resin', 'Resin', 5, 200, null, null, false, false, 'processed'),
  ('copper', 'Copper', 10, 300, null, null, false, false, 'metal'),
  ('volcanic_ore', 'Volcanic Ore', 40, 300, null, null, false, false, 'ore'),
  ('captives', 'Captives', 60, 300, null, null, false, false, 'contraband'),
  ('provision', 'Provision', 40, 500, null, null, false, false, 'food'),
  ('canvas', 'Sailcloth', 10, 700, null, null, false, false, 'processed'),
  ('beam', 'Beam', 150, 2400, null, null, false, false, 'component'),
  ('bulkhead', 'Bulkhead', 210, 2800, null, null, false, false, 'component'),
  ('plate', 'Plate', 100, 3800, null, null, false, false, 'component'),
  ('bronze', 'Bronze', 90, 3900, null, null, false, false, 'metal'),
  ('amber', 'Amber', 5, 1000, null, null, false, false, 'luxury'),
  ('antiquities', 'Antiquities', 4, 200, null, null, false, false, 'luxury'),
  ('seahorse', 'Seahorse', 1, 10000, null, null, false, false, 'luxury'),
  ('voodoo_skull', 'Voodoo Skull', 7, 40000, null, null, false, false, 'luxury'),
  ('battle_mark', 'Battle Mark', 1, 2000, null, null, false, false, 'currency'),
  ('escudo', 'Escudo', 1, 20000, null, null, false, false, 'currency'),
  ('pirate_token', 'Pirate Token', 1, 1500, null, null, false, false, 'currency'),
  ('chest', 'Chest', 2, 5000, null, null, false, false, 'currency'),
  ('chest_key', 'Chest Key', 1, 250000, null, null, false, false, 'key'),
  ('blueprint_fragment', 'Blueprint Fragment', 1, 100000, null, null, false, false, 'blueprint'),
  ('imperial_blueprint', 'Imperial Blueprint', 1, 10000000, null, null, false, false, 'blueprint'),
  ('modification_blueprint', 'Modification Blueprint', 1, 100000, null, null, false, false, 'blueprint'),
  ('insurance', 'Insurance', 1, 600000, null, null, false, false, 'document'),
  ('construction_license', 'Construction License', 1, 4000000, null, null, false, false, 'document'),
  ('scrolls', 'Scrolls', 1, 500, null, null, false, false, 'document')
on conflict (id) do update set
  name = excluded.name, weight = excluded.weight, base_value = excluded.base_value,
  min_price = excluded.min_price, max_price = excluded.max_price,
  is_trade_good = excluded.is_trade_good, perishable = excluded.perishable,
  category = excluded.category;

-- 20 upgrades. Modifiers apply FLAT FIRST, THEN PERCENT --
-- an ordering verified against live in-game HUD values (ships.json
-- _meta.validationEvidence), not assumed.
--
-- Modifiers with no column in this schema are not seeded: item-loss,
-- sail efficiency, manoeuvrability, armour and crew. None affect trading
-- maths in V1. They are still in data/ships.json when they are needed.
insert into upgrades (id, name, category, hold_flat, hold_percent, speed_flat,
                      speed_percent, cruise_speed_flat, durability_flat,
                      durability_percent, upgrade_slots_flat, prevents_spoilage) values
  ('double_hold', 'Double Hold', 'cargo', 3000, 0, 0, 0, 0, 0, -5, 0, false),
  ('cellars', 'Cellars', 'cargo', 1500, 0, 0, 0, 0, 0, 0, 0, true),
  ('sturdy_frames', 'Sturdy Frames', 'cargo', 0, 12, 0, -15, 0, 0, 10, 0, false),
  ('lightweight_construction', 'Lightweight Construction', 'cargo', 0, 25, 0, 0, 0, 0, 0, 0, false),
  ('reinforced_masts', 'Reinforced Masts', 'speed', 0, 0, 0.6, 0, 0, 0, 0, 0, false),
  ('lightweight_hull', 'Lightweight Hull', 'speed', 0, 0, 0, 4, 0, 0, 0, 0, false),
  ('strong_beams', 'Strong Beams', 'speed', 0, 0, 0, -5, 0, 0, 5, 0, false),
  ('cheap_sails', 'Cheap Sails', 'sails', 0, 0, 0, 0, 2, 0, 0, 0, false),
  ('stitched_sails', 'Stitched Sails', 'sails', 0, 0, 0, 0, 2.4, 0, 0, 0, false),
  ('ultralight_sails', 'Ultra-light Sails', 'sails', 0, 0, 0, 0, 2.4, 0, 0, 0, false),
  ('storm_sails', 'Storm Sails', 'sails', 0, 0, 0, 0, 2.7, 0, 0, 0, false),
  ('elite_sails', 'Elite Sails', 'sails', 0, 0, 0, 0, 2.8, 0, 0, 0, false),
  ('tacking_sails', 'Tacking Sails', 'sails', 0, 0, 0, 0, 2.8, 0, 0, 0, false),
  ('reefed_sails', 'Reefed Sails', 'sails', 0, 0, 0, 0, 2.9, 0, 0, 0, false),
  ('tarpaulin_sails', 'Tarpaulin Sails', 'sails', 0, 0, 0, 0, 3.1, 0, 0, 0, false),
  ('raiding_sails', 'Raiding Sails', 'sails', 0, 0, 0, 0, 4.1, 0, 0, 0, false),
  ('structural_expansion', 'Structural Expansion', 'other', 0, 0, 0, 0, 0, 0, 0, 2, false),
  ('repair_arsenal', 'Repair Arsenal', 'other', 0, 0, 0, 0, 0, 80, 0, 0, false),
  ('teak_frames', 'Teak Frames', 'other', 0, 0, 0, 0, 0, 0, 0, 0, false),
  ('extra_bunks', 'Extra Bunks', 'other', 0, 0, 0, 0, 0, 0, 0, 0, false)
on conflict (id) do update set
  name = excluded.name, category = excluded.category,
  hold_flat = excluded.hold_flat, hold_percent = excluded.hold_percent,
  speed_flat = excluded.speed_flat, speed_percent = excluded.speed_percent,
  cruise_speed_flat = excluded.cruise_speed_flat,
  durability_flat = excluded.durability_flat,
  durability_percent = excluded.durability_percent,
  upgrade_slots_flat = excluded.upgrade_slots_flat,
  prevents_spoilage = excluded.prevents_spoilage;

-- ---------------------------------------------------------------------
-- Row count assertions (SPEC.md 3.3). If any of these fail the whole
-- script rolls back, so a short import cannot pass silently.
-- ---------------------------------------------------------------------
do $seed_check$
declare
  n integer;
begin
  select count(*) into n from ports;
  if n <> 42 then
    raise exception 'ports: expected 42 rows, found %', n;
  end if;
  select count(*) into n from ships;
  if n <> 38 then
    raise exception 'ships: expected 38 rows, found %', n;
  end if;
  select count(*) into n from goods where is_trade_good;
  if n <> 20 then
    raise exception 'goods (trade goods): expected 20 rows, found %', n;
  end if;
  select count(*) into n from goods where not is_trade_good;
  if n <> 41 then
    raise exception 'goods (craft + special): expected 41 rows, found %', n;
  end if;
  select count(*) into n from goods;
  if n <> 61 then
    raise exception 'goods (total): expected 61 rows, found %', n;
  end if;
  select count(*) into n from upgrades;
  if n <> 20 then
    raise exception 'upgrades: expected 20 rows, found %', n;
  end if;
  select count(*) into n from servers;
  if n <> 4 then
    raise exception 'servers: expected 4 rows, found %', n;
  end if;
  raise notice 'Seed OK: % ports, % ships, % goods (% trade, % other), % upgrades',
    42, 38, 61, 20, 41, 20;
end $seed_check$;
`;

export const demoPricesSql = `-- =====================================================================
-- WOSB Trade Tool -- demo prices (OPTIONAL).
--
-- GENERATED FILE. Do not edit by hand: run \`npm run gen:sql\` instead.
--
-- Run this LAST, after schema.sql and seed.sql. It is optional: skip it
-- and the app simply has no prices until you enter real ones.
--
-- Every price row here is is_demo = true and source = demo. The
-- prices_current view ignores a demo row for a (port, good) as soon as any
-- real submission exists for it, so real data always wins and nothing
-- needs cleaning up.
--
-- To remove the demo data entirely:
--   delete from price_submissions where is_demo and server_id = 'na';
--   delete from port_state_submissions where is_demo and server_id = 'na';
-- =====================================================================

-- ---------------------------------------------------------------------
-- Port state.
--
-- CAVEAT, read before trusting these: the tax rates and shallow-water
-- limits below are real values observed in game and recorded in
-- data/ports.json. What was never recorded is WHICH SERVER they were seen
-- on, so they are seeded for 'na' only and may be wrong for yours.
--
-- Because of that they ship as DEMO rows. The port_state_current view
-- drops a demo row for a port the moment anyone records a real observation
-- there, so a wrong seeded tax cannot outlive the first real sighting.
--
-- docking_fee stays null everywhere: it has never been observed at all.
-- Charleston deliberately gets no row, so the calculator has to say
-- "tax unknown" rather than assume a rate.
-- ---------------------------------------------------------------------
delete from port_state_submissions where is_demo and server_id = 'na';

insert into port_state_submissions
  (server_id, port_id, tax_percent, docking_fee, min_ship_rate,
   controlling_faction, port_level, port_type, has_market,
   submitted_by, source, is_demo, observed_at) values
  ('na', 'st_john', 12, null, null, null, null, 'settlement', true, null, 'demo', true, now()),
  ('na', 'bord_radel', 8, null, null, 'antilia', null, null, true, null, 'demo', true, now()),
  ('na', 'fiji', 8, null, 6, 'espaniol', null, 'city', true, null, 'demo', true, now()),
  ('na', 'los_catuano', 8, null, 6, 'espaniol', null, null, true, null, 'demo', true, now());

-- ---------------------------------------------------------------------
-- Prices. Clearing demo rows first keeps this file re-runnable without
-- piling up duplicates. Only demo rows are touched; real submissions are
-- never deleted, because the price history is what makes the data
-- trustworthy.
-- ---------------------------------------------------------------------
delete from price_submissions where is_demo and server_id = 'na';

insert into price_submissions
  (server_id, port_id, good_id, buy_price, sell_price, stock,
   submitted_by, source, is_demo, observed_at) values
  ('na', 'st_john', 'beer', 52, 52, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'beer', 88, 88, null, null, 'demo', true, now()),
  ('na', 'charleston', 'beer', 70, 70, null, null, 'demo', true, now()),
  ('na', 'fiji', 'beer', 70, 70, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'beer', 70, 70, null, null, 'demo', true, now()),
  ('na', 'st_john', 'dates', 82, 82, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'dates', 90, 90, null, null, 'demo', true, now()),
  ('na', 'charleston', 'dates', 135, 135, null, null, 'demo', true, now()),
  ('na', 'fiji', 'dates', 140, 140, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'dates', 140, 140, null, null, 'demo', true, now()),
  ('na', 'st_john', 'grog', 95, 95, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'grog', 155, 155, null, null, 'demo', true, now()),
  ('na', 'charleston', 'grog', 120, 120, null, null, 'demo', true, now()),
  ('na', 'fiji', 'grog', 120, 120, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'grog', 120, 120, null, null, 'demo', true, now()),
  ('na', 'st_john', 'nuts', 92, 92, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'nuts', 96, 96, null, null, 'demo', true, now()),
  ('na', 'charleston', 'nuts', 150, 150, null, null, 'demo', true, now()),
  ('na', 'fiji', 'nuts', 120, 120, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'nuts', 120, 120, null, null, 'demo', true, now()),
  ('na', 'st_john', 'wine', 95, 95, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'wine', 158, 158, null, null, 'demo', true, now()),
  ('na', 'charleston', 'wine', 130, 130, null, null, 'demo', true, now()),
  ('na', 'fiji', 'wine', 120, 120, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'wine', 120, 120, null, null, 'demo', true, now()),
  ('na', 'st_john', 'mango', 115, 115, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'mango', 120, 120, null, null, 'demo', true, now()),
  ('na', 'charleston', 'mango', 180, 180, null, null, 'demo', true, now()),
  ('na', 'fiji', 'mango', 190, 190, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'mango', 190, 190, null, null, 'demo', true, now()),
  ('na', 'st_john', 'pineapples', 118, 118, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'pineapples', 185, 185, null, null, 'demo', true, now()),
  ('na', 'charleston', 'pineapples', 140, 140, null, null, 'demo', true, now()),
  ('na', 'fiji', 'pineapples', 150, 150, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'pineapples', 150, 150, null, null, 'demo', true, now()),
  ('na', 'st_john', 'oil', 135, 135, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'oil', 215, 215, null, null, 'demo', true, now()),
  ('na', 'charleston', 'oil', 160, 160, null, null, 'demo', true, now()),
  ('na', 'fiji', 'oil', 170, 170, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'oil', 170, 170, null, null, 'demo', true, now()),
  ('na', 'st_john', 'paprika', 158, 158, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'paprika', 162, 162, null, null, 'demo', true, now()),
  ('na', 'charleston', 'paprika', 250, 250, null, null, 'demo', true, now()),
  ('na', 'fiji', 'paprika', 260, 260, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'paprika', 260, 260, null, null, 'demo', true, now()),
  ('na', 'st_john', 'salt', 185, 185, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'salt', 305, 305, null, null, 'demo', true, now()),
  ('na', 'charleston', 'salt', 220, 220, null, null, 'demo', true, now()),
  ('na', 'fiji', 'salt', 240, 240, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'salt', 230, 230, null, null, 'demo', true, now()),
  ('na', 'st_john', 'leather', 205, 205, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'leather', 210, 210, null, null, 'demo', true, now()),
  ('na', 'charleston', 'leather', 330, 330, null, null, 'demo', true, now()),
  ('na', 'fiji', 'leather', 270, 270, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'leather', 260, 260, null, null, 'demo', true, now()),
  ('na', 'st_john', 'pepper', 215, 215, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'pepper', 350, 350, null, null, 'demo', true, now()),
  ('na', 'charleston', 'pepper', 260, 260, null, null, 'demo', true, now()),
  ('na', 'fiji', 'pepper', 280, 280, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'pepper', 280, 280, null, null, 'demo', true, now()),
  ('na', 'st_john', 'vanilla', 225, 225, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'vanilla', 230, 230, null, null, 'demo', true, now()),
  ('na', 'charleston', 'vanilla', 370, 370, null, null, 'demo', true, now()),
  ('na', 'fiji', 'vanilla', 290, 290, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'vanilla', 290, 290, null, null, 'demo', true, now()),
  ('na', 'st_john', 'cinnamon', 235, 235, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'cinnamon', 385, 385, null, null, 'demo', true, now()),
  ('na', 'charleston', 'cinnamon', 300, 300, null, null, 'demo', true, now()),
  ('na', 'fiji', 'cinnamon', 390, 390, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'cinnamon', 390, 390, null, null, 'demo', true, now()),
  ('na', 'st_john', 'rugs', 245, 245, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'rugs', 250, 250, null, null, 'demo', true, now()),
  ('na', 'charleston', 'rugs', 400, 400, null, null, 'demo', true, now()),
  ('na', 'fiji', 'rugs', 410, 410, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'rugs', 410, 410, null, null, 'demo', true, now()),
  ('na', 'st_john', 'coffee', 255, 255, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'coffee', 425, 425, null, null, 'demo', true, now()),
  ('na', 'charleston', 'coffee', 320, 320, null, null, 'demo', true, now()),
  ('na', 'fiji', 'coffee', 330, 330, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'coffee', 330, 330, null, null, 'demo', true, now()),
  ('na', 'st_john', 'sugar', 305, 305, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'sugar', 310, 310, null, null, 'demo', true, now()),
  ('na', 'charleston', 'sugar', 500, 500, null, null, 'demo', true, now()),
  ('na', 'fiji', 'sugar', 400, 400, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'sugar', 390, 390, null, null, 'demo', true, now()),
  ('na', 'st_john', 'tobacco', 325, 325, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'tobacco', 540, 540, null, null, 'demo', true, now()),
  ('na', 'charleston', 'tobacco', 400, 400, null, null, 'demo', true, now()),
  ('na', 'fiji', 'tobacco', 420, 420, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'tobacco', 420, 420, null, null, 'demo', true, now()),
  ('na', 'st_john', 'saffron', 375, 375, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'saffron', 380, 380, null, null, 'demo', true, now()),
  ('na', 'charleston', 'saffron', 620, 620, null, null, 'demo', true, now()),
  ('na', 'fiji', 'saffron', 630, 630, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'saffron', 630, 630, null, null, 'demo', true, now()),
  ('na', 'st_john', 'silk', 530, 530, null, null, 'demo', true, now()),
  ('na', 'bord_radel', 'silk', 870, 870, null, null, 'demo', true, now()),
  ('na', 'charleston', 'silk', 650, 650, null, null, 'demo', true, now()),
  ('na', 'fiji', 'silk', 880, 880, null, null, 'demo', true, now()),
  ('na', 'los_catuano', 'silk', 880, 880, null, null, 'demo', true, now()),
  ('na', 'st_john', 'wood', 38, 35, 5000, null, 'demo', true, now()),
  ('na', 'bord_radel', 'wood', 50, 46, 4200, null, 'demo', true, now()),
  ('na', 'fiji', 'wood', 42, 39, 3800, null, 'demo', true, now()),
  ('na', 'st_john', 'rum', 130, 122, 400, null, 'demo', true, now()),
  ('na', 'bord_radel', 'rum', 158, 148, 260, null, 'demo', true, now()),
  ('na', 'fiji', 'rum', 141, 132, 310, null, 'demo', true, now()),
  ('na', 'st_john', 'resin', 430, 405, 120, null, 'demo', true, now()),
  ('na', 'bord_radel', 'resin', 505, 475, 80, null, 'demo', true, now()),
  ('na', 'fiji', 'resin', 460, 430, 95, null, 'demo', true, now()),
  ('na', 'st_john', 'copper', 195, 175, 300, null, 'demo', true, now()),
  ('na', 'bord_radel', 'copper', 245, 220, 210, null, 'demo', true, now()),
  ('na', 'fiji', 'copper', 220, 189, 260, null, 'demo', true, now()),
  ('na', 'st_john', 'water', 18, 8, 900, null, 'demo', true, now()),
  ('na', 'bord_radel', 'water', 25, 12, 640, null, 'demo', true, now()),
  ('na', 'fiji', 'water', 21, 9, 720, null, 'demo', true, now());

-- ---------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------
do $demo_check$
declare
  n integer;
begin
  select count(*) into n from price_submissions where is_demo and server_id = 'na';
  if n <> 115 then
    raise exception 'demo prices: expected 115 rows, found %', n;
  end if;

  -- Every demo row must be reachable through the view, since no real
  -- submissions exist yet to displace them.
  select count(*) into n from prices_current where is_demo and server_id = 'na';
  if n <> 115 then
    raise exception 'prices_current should expose all 115 demo rows, found %', n;
  end if;

  select count(*) into n from port_state_current where is_demo and server_id = 'na';
  if n <> 4 then
    raise exception 'port_state_current should expose 4 demo port rows, found %', n;
  end if;

  raise notice 'Demo OK: % price rows and % port rows, all flagged as demo', 115, 4;
end $demo_check$;
`;

export interface Migration {
  name: string;
  checksum: string;
  sql: string;
}

/** Post-baseline schema changes, applied in this order. */
export const migrations: Migration[] = [
  {
    name: '0001_value_constraints.sql',
    checksum: '78021b2669a018e6',
    sql: `-- Reject impossible values at the database, not just in the app.
--
-- Found by probing the calculator with hostile input: a buy price of -10.0
-- gold made every good look enormously profitable, because a negative cost is
-- free money to the arithmetic. Nothing stopped such a row being stored.
--
-- The calculator is not the right place to catch this. A price arrives from
-- manual entry, from OCR, and later from screen capture, and any of those can
-- produce nonsense. One rule at the bottom covers all of them, and it cannot
-- be forgotten in a code path written later.
--
-- These are deliberately loose: they reject the impossible, not the merely
-- surprising. Judging whether a real price is plausible is what the min/max
-- bands and Phase 4 moderation are for.
--
-- Safe to run twice: each constraint is added only if it is not already there.

do $constraints$
declare
  wanted record;
begin
  for wanted in
    select * from (values
      -- Money and quantities can be unknown, but never negative.
      ('price_submissions',      'price_buy_nonneg',      'buy_price is null or buy_price >= 0'),
      ('price_submissions',      'price_sell_nonneg',     'sell_price is null or sell_price >= 0'),
      ('price_submissions',      'price_stock_nonneg',    'stock is null or stock >= 0'),

      -- A tax rate outside 0..100 is not a rate. Observed real values run 4-12.
      ('port_state_submissions', 'port_tax_range',        'tax_percent is null or (tax_percent >= 0 and tax_percent <= 100)'),
      ('port_state_submissions', 'port_fee_nonneg',       'docking_fee is null or docking_fee >= 0'),
      -- Ship rates are 1 to 7. Anything else would silently gate every ship
      -- out of a port, or none of them.
      ('port_state_submissions', 'port_min_rate_range',   'min_ship_rate is null or (min_ship_rate >= 1 and min_ship_rate <= 7)'),
      ('port_state_submissions', 'port_level_nonneg',     'port_level is null or port_level >= 0'),

      -- A good weighing nothing would let an unlimited quantity into the hold.
      ('goods',                  'goods_weight_positive', 'weight > 0'),
      ('goods',                  'goods_base_nonneg',     'base_value is null or base_value >= 0'),
      ('goods',                  'goods_min_nonneg',      'min_price is null or min_price >= 0'),
      ('goods',                  'goods_max_nonneg',      'max_price is null or max_price >= 0'),

      ('ships',                  'ships_rate_range',      'rate >= 1 and rate <= 7'),
      ('ships',                  'ships_hold_positive',   'hold > 0')
    ) as t(table_name, constraint_name, check_expression)
  loop
    if not exists (
      select 1 from pg_constraint
       where conname = wanted.constraint_name
         and conrelid = wanted.table_name::regclass
    ) then
      execute format(
        'alter table %I add constraint %I check (%s)',
        wanted.table_name, wanted.constraint_name, wanted.check_expression
      );
    end if;
  end loop;
end $constraints$;
`,
  },
  {
    name: '0002_trust_boundaries.sql',
    checksum: 'f22752188e6ba3ba',
    sql: `-- Close the holes a code review found in the Phase 3 write path.
--
-- Every one of these was reproduced against a real Postgres before being
-- written, and each is enforced HERE rather than in the app because the app is
-- not the only writer: manual entry, OCR and later screen capture all reach
-- the same tables, and a rule in one client is a rule the next client forgets.
--
-- Safe to run twice: every change is guarded.

-- ---------------------------------------------------------------------
-- 1. A submission cannot be dated in the future.
--
-- \`prices_current\` picks the row with the newest \`observed_at\`, and the insert
-- policy checks who you are but never *when* you claim to have been there. So
-- one row dated 2999-01-01 wins forever and every honest price submitted
-- afterwards sorts below it. Verified: an ordinary contributor pinned a price
-- at 100, and a later honest submission of 250 was simply not returned.
--
-- \`port_state_submissions\` has the same shape and is worse, because
-- \`port_state_current\` resolves each column independently by \`observed_at\` --
-- a single poisoned row containing only \`tax_percent\` pins that port's tax
-- rate permanently, and tax is a direct input to every profit calculation.
-- Verified: tax pinned at 99%.
--
-- Freshness makes it louder still: the UI computes \`now - observed_at\`, so a
-- future date reads as maximally fresh and the poisoned value wears the
-- strongest confidence badge on the screen.
--
-- An hour of slack absorbs clock skew between a phone and the server without
-- being useful to anyone trying to pin a value.
do $observed_at$
declare
  wanted record;
begin
  for wanted in
    select * from (values
      ('price_submissions',      'price_observed_not_future'),
      ('port_state_submissions', 'port_state_observed_not_future')
    ) as t(table_name, constraint_name)
  loop
    if not exists (
      select 1 from pg_constraint
       where conname = wanted.constraint_name
         and conrelid = wanted.table_name::regclass
    ) then
      execute format(
        'alter table %I add constraint %I check (observed_at <= now() + interval ''1 hour'')',
        wanted.table_name, wanted.constraint_name
      );
    end if;
  end loop;
end $observed_at$;

-- ---------------------------------------------------------------------
-- 2. A price submission must actually say something.
--
-- \`JSON.stringify\` turns NaN and Infinity into \`null\`, which is how supabase-js
-- puts a payload on the wire. A caller holding a non-finite number therefore
-- sends a row where buy, sell and stock are all null -- and because
-- \`prices_current\` takes whole rows by \`observed_at desc\`, that content-free
-- row becomes the current price and a real observation is destroyed. Verified:
-- 220/189/40 replaced by null/null/null.
--
-- The client now rejects non-finite values too, but this is the layer that
-- cannot be forgotten by a future caller, and OCR is exactly such a caller.
do $has_value$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'price_has_some_value'
       and conrelid = 'price_submissions'::regclass
  ) then
    -- Only added if the existing data can satisfy it; an all-null row already
    -- stored would otherwise make this migration fail forever.
    if not exists (
      select 1 from price_submissions
       where buy_price is null and sell_price is null and stock is null
    ) then
      alter table price_submissions
        add constraint price_has_some_value
        check (buy_price is not null or sell_price is not null or stock is not null);
    end if;
  end if;
end $has_value$;

-- ---------------------------------------------------------------------
-- 3. An abusive contributor can actually be removed.
--
-- \`profiles.id\` cascades from \`auth.users\`, but \`submitted_by\` referenced
-- \`profiles(id)\` with no ON DELETE clause, so the delete was blocked the
-- moment that contributor had submitted anything -- which is precisely when
-- you would want to remove them. Verified: "update or delete on table
-- profiles violates foreign key constraint".
--
-- SET NULL rather than CASCADE: their observations may well be honest, and
-- deleting a contributor should not silently delete community data. The rows
-- survive, unattributed; an admin flags the bad ones.
do $fks$
declare
  wanted record;
begin
  for wanted in
    select * from (values
      ('price_submissions',      'price_submissions_submitted_by_fkey'),
      ('port_state_submissions', 'port_state_submissions_submitted_by_fkey')
    ) as t(table_name, constraint_name)
  loop
    if exists (
      select 1 from pg_constraint
       where conname = wanted.constraint_name
         and conrelid = wanted.table_name::regclass
         and confdeltype <> 'n'   -- 'n' = SET NULL; anything else needs replacing
    ) then
      execute format('alter table %I drop constraint %I', wanted.table_name, wanted.constraint_name);
      execute format(
        'alter table %I add constraint %I foreign key (submitted_by) references profiles(id) on delete set null',
        wanted.table_name, wanted.constraint_name
      );
    end if;
  end loop;
end $fks$;
`,
  },
  {
    name: '0003_ocr_usage.sql',
    checksum: 'b5d6cd986eca37c2',
    sql: `-- Per-account rate limiting for the OCR endpoint (SPEC.md 7.2, safeguard 4).
--
-- Every OCR request spends real money at Anthropic, so an unlimited endpoint is
-- an unlimited bill. The account-wide spend cap set on the API key is the
-- backstop; it protects the wallet but not the service -- one abusive account
-- can exhaust it and every honest contributor is then locked out for the rest
-- of the month. So the limit has to be per account, and it has to be counted
-- somewhere every instance of the function can see.
--
-- Why not the in-memory counter api/anon-session.ts uses: serverless instances
-- do not share memory. That counter only slows a burst that happens to land on
-- one warm instance, which is a speed bump for account creation and would be
-- meaningless here -- a caller who simply retries gets a fresh instance with a
-- fresh, empty counter. This table is the shared truth instead.
--
-- Safe to run twice.

create table if not exists ocr_usage (
  user_id uuid not null,
  -- Hour buckets rather than a row per request: it keeps the table tiny and
  -- makes both windows below a single sum, with no per-request history to
  -- prune or to leak anything about what anyone photographed.
  hour    timestamptz not null,
  count   integer not null default 0,
  primary key (user_id, hour),
  constraint ocr_usage_count_nonneg check (count >= 0)
);

-- No policies are created for this table, deliberately. RLS with no policy
-- denies everything, so no browser can read another contributor's usage or
-- write its own. Only the service role -- which bypasses RLS and lives solely
-- inside the serverless function -- touches it.
alter table ocr_usage enable row level security;

-- ---------------------------------------------------------------------
-- Charge one request and report whether it is allowed.
--
-- Done as one statement in the database rather than read-then-write in the
-- function, because two concurrent uploads that both read "9 of 10" would both
-- write 10 and both proceed. \`on conflict do update ... returning\` is atomic:
-- the second caller sees 11 and is refused.
--
-- The row is inserted BEFORE the decision, so a refused request still counts.
-- That is intentional -- otherwise a caller who is already over the limit pays
-- nothing for hammering the endpoint.
-- ---------------------------------------------------------------------
create or replace function ocr_charge(p_user uuid, p_hour_limit int, p_day_limit int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $ocr_charge$
declare
  this_hour timestamptz := date_trunc('hour', now());
  hour_count int;
  day_count  int;
begin
  insert into ocr_usage (user_id, hour, count)
  values (p_user, this_hour, 1)
  on conflict (user_id, hour) do update set count = ocr_usage.count + 1
  returning count into hour_count;

  select coalesce(sum(count), 0) into day_count
    from ocr_usage
   where user_id = p_user
     and hour > now() - interval '24 hours';

  -- Nothing here is worth keeping once both windows have passed.
  delete from ocr_usage where hour < now() - interval '48 hours';

  return jsonb_build_object(
    'hour', hour_count,
    'day', day_count,
    'allowed', hour_count <= p_hour_limit and day_count <= p_day_limit
  );
end
$ocr_charge$;

-- security definer means this function runs with the owner's rights, so who
-- may CALL it is the whole access control story. Only the service role may.
revoke all on function ocr_charge(uuid, int, int) from public;
revoke all on function ocr_charge(uuid, int, int) from anon;
revoke all on function ocr_charge(uuid, int, int) from authenticated;
grant execute on function ocr_charge(uuid, int, int) to service_role;

-- Grants and RLS are two separate gates and both are shut here. RLS with no
-- policy already denies every row, but Supabase attaches default privileges to
-- new tables in \`public\`, and inheriting whatever those happen to be is not the
-- same as saying what is meant. Nothing but the function above touches this
-- table, so nothing but the function above is granted anything on it.
revoke all on ocr_usage from anon, authenticated;

-- PostgREST caches the database's shape, so a function created a moment ago is
-- invisible to the REST API until it refreshes -- which would make the first
-- upload fail with a baffling 404 rather than a rate-limit answer.
notify pgrst, 'reload schema';
`,
  },
  {
    name: '0004_anon_session_limits.sql',
    checksum: 'b75e7df96af547bd',
    sql: `-- A real rate limit on account creation.
--
-- THE HOLE THIS CLOSES. \`/api/anon-session\` creates a permanent auth user and
-- is unauthenticated by definition -- it has to be, since its whole job is to
-- give a brand-new visitor an identity. Its only protection was an in-memory
-- counter, which fails two ways at once:
--
--   1. Serverless instances do not share memory, so a caller who simply keeps
--      retrying lands on a cold instance with an empty counter. It slows a
--      burst on one warm instance and stops nothing else.
--   2. It counted against \`X-Forwarded-For\`, which is an ordinary request
--      header the CALLER writes. Varying it per request made the limit vanish
--      entirely, without even needing a new instance.
--
-- The consequence is not just Supabase MAU: every account is a "voter", and
-- Phase 4 weights community prices by contributor consensus. Unlimited
-- accounts means unlimited votes, which would quietly break moderation before
-- it is built. So this lands before Phase 4, not with it.
--
-- Same shape as ocr_charge() in 0003, deliberately -- one proven pattern, two
-- uses. If a THIRD limiter ever appears, generalise these two into a single
-- scoped table then, not before.
--
-- Safe to run twice.

create table if not exists anon_session_usage (
  -- A KEYED HASH of the caller's address, never the address itself. An IPv4
  -- space is small enough to brute-force a bare SHA-256 back to the original,
  -- so the serverless function mixes in a server-only secret before hashing.
  -- Nothing here can be turned back into "who", which is the point: this table
  -- exists to count, not to identify.
  subject text        not null,
  hour    timestamptz not null,
  count   integer     not null default 0,
  primary key (subject, hour),
  constraint anon_session_usage_count_nonneg check (count >= 0)
);

-- No policies, deliberately: RLS with none denies everything. Only the service
-- role -- which lives solely inside the serverless function -- reaches this,
-- and then only through the function below.
alter table anon_session_usage enable row level security;
revoke all on anon_session_usage from anon, authenticated;

-- ---------------------------------------------------------------------
-- Charge one attempt and say whether it is allowed.
--
-- One statement, so two concurrent requests that both read "9 of 10" cannot
-- both write 10. The row is inserted BEFORE the decision, so a refused attempt
-- still counts -- otherwise being over the limit costs nothing and the refusal
-- is free to ignore.
-- ---------------------------------------------------------------------
create or replace function anon_session_charge(
  p_subject text, p_hour_limit int, p_day_limit int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $anon_session_charge$
declare
  this_hour timestamptz := date_trunc('hour', now());
  hour_count int;
  day_count  int;
begin
  insert into anon_session_usage (subject, hour, count)
  values (p_subject, this_hour, 1)
  on conflict (subject, hour) do update set count = anon_session_usage.count + 1
  returning count into hour_count;

  select coalesce(sum(count), 0) into day_count
    from anon_session_usage
   where subject = p_subject
     and hour > now() - interval '24 hours';

  delete from anon_session_usage where hour < now() - interval '48 hours';

  return jsonb_build_object(
    'hour', hour_count,
    'day', day_count,
    'allowed', hour_count <= p_hour_limit and day_count <= p_day_limit
  );
end
$anon_session_charge$;

-- security definer runs with the owner's rights, so who may CALL it is the
-- entire access control story.
revoke all on function anon_session_charge(text, int, int) from public;
revoke all on function anon_session_charge(text, int, int) from anon;
revoke all on function anon_session_charge(text, int, int) from authenticated;
grant execute on function anon_session_charge(text, int, int) to service_role;

notify pgrst, 'reload schema';
`,
  },
];
