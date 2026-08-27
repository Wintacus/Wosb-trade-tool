-- Per-account rate limiting for the OCR endpoint (SPEC.md 7.2, safeguard 4).
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
-- write 10 and both proceed. `on conflict do update ... returning` is atomic:
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
-- new tables in `public`, and inheriting whatever those happen to be is not the
-- same as saying what is meant. Nothing but the function above touches this
-- table, so nothing but the function above is granted anything on it.
revoke all on ocr_usage from anon, authenticated;

-- PostgREST caches the database's shape, so a function created a moment ago is
-- invisible to the REST API until it refreshes -- which would make the first
-- upload fail with a baffling 404 rather than a rate-limit answer.
notify pgrst, 'reload schema';
