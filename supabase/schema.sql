-- =====================================================================
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

-- security definer: runs as the function owner, so it can read `admins`
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
  submitted_by        uuid references profiles(id),   -- null for demo rows
  source              text not null default 'manual', -- manual | ocr | demo
  is_demo             boolean not null default false,
  observed_at         timestamptz not null default now(),
  flagged             boolean not null default false,
  flag_reason         text,
  constraint port_tax_range      check (tax_percent is null or (tax_percent >= 0 and tax_percent <= 100)),
  constraint port_fee_nonneg     check (docking_fee is null or docking_fee >= 0),
  constraint port_min_rate_range check (min_ship_rate is null or (min_ship_rate >= 1 and min_ship_rate <= 7)),
  constraint port_level_nonneg   check (port_level is null or port_level >= 0)
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
-- array_agg with `(field is null)` first in the ordering puts rows that have a
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
  submitted_by uuid references profiles(id),   -- null for demo rows
  source       text not null default 'manual', -- manual | ocr | screenshare | demo
  is_demo      boolean not null default false,
  observed_at  timestamptz not null default now(),
  flagged      boolean not null default false,
  flag_reason  text,
  -- Money and quantities can be unknown, but never negative. A negative buy
  -- price would read as free money to the profit arithmetic.
  constraint price_buy_nonneg   check (buy_price  is null or buy_price  >= 0),
  constraint price_sell_nonneg  check (sell_price is null or sell_price >= 0),
  constraint price_stock_nonneg check (stock      is null or stock      >= 0)
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
order by server_id, port_id, good_id, observed_at desc;

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

-- `admins` deliberately gets no policies at all: unreachable through the API.

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
  if (new.id, new.server_id, new.port_id, new.good_id, new.buy_price,
      new.sell_price, new.stock, new.submitted_by, new.source, new.is_demo,
      new.observed_at)
     is distinct from
     (old.id, old.server_id, old.port_id, old.good_id, old.buy_price,
      old.sell_price, old.stock, old.submitted_by, old.source, old.is_demo,
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
  if (new.id, new.server_id, new.port_id, new.tax_percent, new.docking_fee,
      new.min_ship_rate, new.controlling_faction, new.port_level,
      new.port_type, new.has_market, new.submitted_by, new.source,
      new.is_demo, new.observed_at)
     is distinct from
     (old.id, old.server_id, old.port_id, old.tax_percent, old.docking_fee,
      old.min_ship_rate, old.controlling_faction, old.port_level,
      old.port_type, old.has_market, old.submitted_by, old.source,
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
-- ---------------------------------------------------------------------
drop policy if exists seasons_read_all     on seasons;
drop policy if exists seasons_write_authed on seasons;

create policy seasons_read_all on seasons for select using (true);
create policy seasons_write_authed on seasons
  for all to authenticated using (true) with check (true);

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
-- adds default privileges to new tables in `public`, so without the revoke
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
grant select, insert, update, delete on seasons to authenticated;

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
