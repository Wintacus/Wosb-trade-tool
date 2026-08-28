-- A real rate limit on account creation.
--
-- THE HOLE THIS CLOSES. `/api/anon-session` creates a permanent auth user and
-- is unauthenticated by definition -- it has to be, since its whole job is to
-- give a brand-new visitor an identity. Its only protection was an in-memory
-- counter, which fails two ways at once:
--
--   1. Serverless instances do not share memory, so a caller who simply keeps
--      retrying lands on a cold instance with an empty counter. It slows a
--      burst on one warm instance and stops nothing else.
--   2. It counted against `X-Forwarded-For`, which is an ordinary request
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
