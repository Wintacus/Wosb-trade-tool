-- Close the holes a code review found in the Phase 3 write path.
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
-- `prices_current` picks the row with the newest `observed_at`, and the insert
-- policy checks who you are but never *when* you claim to have been there. So
-- one row dated 2999-01-01 wins forever and every honest price submitted
-- afterwards sorts below it. Verified: an ordinary contributor pinned a price
-- at 100, and a later honest submission of 250 was simply not returned.
--
-- `port_state_submissions` has the same shape and is worse, because
-- `port_state_current` resolves each column independently by `observed_at` --
-- a single poisoned row containing only `tax_percent` pins that port's tax
-- rate permanently, and tax is a direct input to every profit calculation.
-- Verified: tax pinned at 99%.
--
-- Freshness makes it louder still: the UI computes `now - observed_at`, so a
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
-- `JSON.stringify` turns NaN and Infinity into `null`, which is how supabase-js
-- puts a payload on the wire. A caller holding a non-finite number therefore
-- sends a row where buy, sell and stock are all null -- and because
-- `prices_current` takes whole rows by `observed_at desc`, that content-free
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
-- `profiles.id` cascades from `auth.users`, but `submitted_by` referenced
-- `profiles(id)` with no ON DELETE clause, so the delete was blocked the
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
