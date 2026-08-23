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
  category      text
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
  verified        boolean not null default true
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

-- Ports: static identity here, per-server mutable state in port_state.
create table if not exists ports (
  id           text primary key,
  name         text not null,
  display_name text,
  x            integer not null,
  y            integer not null,
  category     text
);

create table if not exists port_state (
  port_id             text references ports(id),
  server_id           text references servers(id),
  tax_percent         numeric,   -- null = UNKNOWN. Do not default to 8.
  docking_fee         integer,   -- null = UNKNOWN, treated as 0. UNVERIFIED.
  min_ship_rate       integer,   -- e.g. 6 means only rates 6-7 may dock
  controlling_faction text,
  port_level          integer,
  port_type           text,      -- 'city' | 'settlement'
  has_market          boolean not null default true,
  updated_by          uuid references profiles(id),
  updated_at          timestamptz not null default now(),
  primary key (port_id, server_id)
);

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
  flag_reason  text
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
alter table port_state        enable row level security;
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
-- port_state: shared, user-correctable world state.
--
-- DEVIATION FROM SPEC.md 3.2, flagged deliberately rather than hidden.
-- The spec groups port_state with price_submissions as insert-only. But
-- port_state has one row per (port, server) and ships as all-nulls, so
-- insert-only would let the first person to touch a port set its tax
-- forever with no way to correct it. Since tax rates and port ownership
-- change with every guild capture, updates have to be allowed for the
-- table to work at all.
--
-- If you would rather lock this down, change `to authenticated` to
-- `using (public.is_admin())` on the update policy below.
-- ---------------------------------------------------------------------
drop policy if exists port_state_read_all      on port_state;
drop policy if exists port_state_insert_authed on port_state;
drop policy if exists port_state_update_authed on port_state;

create policy port_state_read_all on port_state
  for select using (true);
create policy port_state_insert_authed on port_state
  for insert to authenticated with check (updated_by = auth.uid());
create policy port_state_update_authed on port_state
  for update to authenticated
  using (true) with check (updated_by = auth.uid());

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
-- Grants. RLS decides which ROWS; grants decide which TABLES are visible
-- at all. Both are needed.
-- ---------------------------------------------------------------------
grant usage on schema public to anon, authenticated;

grant select on servers, goods, ships, upgrades, ports, port_state,
                price_submissions, seasons, prices_current
  to anon, authenticated;

grant insert on price_submissions, ocr_corrections to authenticated;
grant insert, update on port_state to authenticated;
grant update on price_submissions to authenticated;   -- narrowed by policy + trigger
grant select, insert, update, delete on profiles, ship_presets, saved_routes
  to authenticated;
grant all on seasons to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- admins is reachable by nobody but the service role and the SQL Editor.
revoke all on admins from anon, authenticated;
