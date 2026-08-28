/**
 * Mints the invisible account that a contribution is attributed to.
 *
 * Why this exists at all: the database will not accept a price submission from
 * a signed-out visitor. The row-level security policy is
 *
 *     for insert to authenticated with check (submitted_by = auth.uid())
 *
 * so every saved observation needs a real identity behind it. That is
 * deliberate -- it is what Phase 4's consensus weighting, outlier detection and
 * "ban a bad actor" all hang off. Without it the only alternative is an
 * anonymous free-for-all with nothing to attribute or moderate.
 *
 * But the person using this app must never see a sign-up form to record a
 * price. So the account is created silently, on the first save, and never
 * mentioned again. SPEC.md 8 later upgrades exactly this account to a real
 * email and password without losing any of its data, because the auth user id
 * never changes.
 *
 * Supabase's own `signInAnonymously()` would do the same job, but it is off by
 * default and can only be switched on by hand in the Supabase dashboard. That
 * would be a manual step for the user, so this endpoint does the equivalent
 * with the service role key instead and needs no configuration at all.
 *
 * SERVER ONLY. The service role key bypasses row-level security entirely and
 * must never reach the browser; a test fails if anything under src/ imports
 * this directory.
 */
import { createHmac } from 'node:crypto';

// Requesting more than a Hobby-tier project actually gets is harmless -- Vercel
// just caps it -- but that plan tier commonly caps real execution around 10s
// regardless of what is asked for, and that ceiling cannot be confirmed from
// inside this sandbox. So this asks for 10, matching the realistic worst case,
// and the code below is written to never depend on getting anywhere near it:
// UPSTREAM_TIMEOUT_MS (8s) is what actually protects the caller, by winning
// the race against whatever the platform's own limit turns out to be.
export const config = { maxDuration: 10 };

/**
 * How long to wait for Supabase's admin API before giving up on it.
 *
 * A healthy call is sub-second, so several seconds already means something is
 * wrong upstream. Kept comfortably under the maxDuration above (and under the
 * ~10s a Hobby-tier function realistically gets) so THIS code's own timeout
 * fires first, producing a readable JSON error, rather than losing the race to
 * Vercel's platform-level gateway timeout -- which is the bare, unparseable
 * 504 that sent the user looking for help in the first place.
 */
const UPSTREAM_TIMEOUT_MS = 5_000;

/**
 * The rate-limit check's slice of that budget.
 *
 * There are now TWO upstream calls in one request -- charge the counter, then
 * create the user -- and they share one function lifetime. 3s + 5s leaves
 * headroom under maxDuration 10, so this code's own timeouts always fire
 * before the platform's, which is the whole point: a readable JSON error
 * instead of the bare, unparseable gateway 504 that sent the user looking for
 * help in the first place. (UPSTREAM_TIMEOUT_MS came down from 8s to make
 * room. A healthy call to either is sub-second.)
 */
const CHARGE_TIMEOUT_MS = 3_000;

interface Req {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

interface Res {
  status: (code: number) => Res;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
}

/**
 * A reserved domain (RFC 2606). These addresses are deliberately undeliverable:
 * nothing is ever sent to them, and no real inbox can ever collide with one.
 */
const ANON_EMAIL_DOMAIN = 'anon.wosb-trade-tool.invalid';

/**
 * How many accounts one address may create.
 *
 * A real person needs exactly ONE, ever -- it is minted on their first save and
 * kept in that browser from then on. So these are generous by a wide margin,
 * and they are set where they are because of carrier-grade NAT: a whole mobile
 * network can share one address, so a tight limit would lock out real
 * contributors who have done nothing wrong. Refusing an honest user is the
 * worse failure here; bounding an attacker to 50 a day instead of unlimited is
 * already the entire win.
 */
const HOUR_LIMIT = 10;
const DAY_LIMIT = 50;

/**
 * Which address this request came from.
 *
 * `x-vercel-forwarded-for` is written by the platform and overwrites whatever
 * the caller sent. `x-forwarded-for` is an ordinary request header the CALLER
 * controls -- the previous limiter keyed on it, so varying it per request made
 * the limit disappear without even needing a new serverless instance. It is
 * deliberately not consulted at all here: a value the attacker chooses is not
 * an identity, and falling back to it would restore the hole in exactly the
 * conditions where the limit matters.
 */
export function callerAddress(headers: Record<string, string | string[] | undefined>): string {
  for (const name of ['x-vercel-forwarded-for', 'x-real-ip']) {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const first = value?.split(',')[0]?.trim();
    if (first) return first;
  }
  // Nothing trustworthy to key on. Every such caller shares one bucket, so the
  // limit still applies -- collectively rather than individually. On Vercel
  // this header is always present, so reaching here means something is wrong,
  // and being loudly restrictive beats being silently unlimited.
  return 'unattributed';
}

/**
 * What actually gets stored: a keyed hash, never the address.
 *
 * A bare SHA-256 of an IPv4 address is reversible -- the whole space is 4
 * billion values, minutes of work -- so the hash is keyed with a secret that
 * exists only on the server. The table can count without being able to say who.
 */
export function subjectFor(address: string, secret: string): string {
  return createHmac('sha256', secret).update(address).digest('hex');
}

/** So the handler can answer 504 rather than a generic 500. */
class LimiterUnavailable extends Error {}

/**
 * Charge one attempt against the shared counter in the database.
 *
 * In the database rather than in memory because serverless instances do not
 * share memory: the old counter was defeated by retrying until a cold instance
 * answered with an empty one. See migrations/0004_anon_session_limits.sql.
 */
async function charge(
  subject: string,
  url: string,
  key: string,
): Promise<{ allowed: boolean; hour: number; day: number }> {
  // Bounded, like every other upstream call here. Without this a hung
  // database would hold the whole function open until Vercel's gateway killed
  // it -- reintroducing the unreadable 504 the rest of this file exists to
  // prevent. Caught by the existing hung-upstream test, which is why it is
  // written the way it is.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHARGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${url}/rest/v1/rpc/anon_session_charge`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_subject: subject,
        p_hour_limit: HOUR_LIMIT,
        p_day_limit: DAY_LIMIT,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const timedOut = error instanceof Error && error.name === 'AbortError';
    throw new LimiterUnavailable(
      timedOut
        ? `The database took longer than ${CHARGE_TIMEOUT_MS / 1000}s to answer, so no ` +
          'account was created. This is usually momentary -- try saving again.'
        : 'Could not reach the database to check the account limit, so no account was created.',
    );
  }
  if (!response.ok) {
    clearTimeout(timer);
    // FAIL CLOSED. A limiter that lets everything through when it breaks is
    // not a limiter. A 404 here specifically means migration 0004 has not been
    // applied -- which cannot normally happen, since migrations run during the
    // same build that ships this code -- so it is surfaced rather than
    // swallowed. The cost is that new contributors cannot sign up until it is
    // fixed; the alternative is the hole silently reopening, unnoticed.
    throw new LimiterUnavailable(
      response.status === 404
        ? 'The account rate limiter is not installed on this database (migration 0004). ' +
          'No account was created.'
        : `The account rate limiter is unavailable (${response.status}). No account was created.`,
    );
  }
  // Read the body BEFORE clearing the timeout: fetch resolves as soon as the
  // headers arrive, so a hung body would otherwise sit unprotected.
  const body = (await response.json()) as { allowed?: boolean; hour?: number; day?: number };
  clearTimeout(timer);
  return { allowed: body.allowed === true, hour: Number(body.hour ?? 0), day: Number(body.day ?? 0) };
}

/** A credential nobody chose and nobody has to remember. */
function randomSecret(bytes = 24): string {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return Array.from(raw, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Nothing may escape uncaught.
 *
 * An exception here would otherwise become Vercel's opaque
 * FUNCTION_INVOCATION_FAILED, or a bare platform-level 504 if it happened
 * mid-request -- exactly the unreadable failure this file exists to prevent.
 * Matches api/migrate.ts's top-level guard. In practice this should rarely
 * fire, because the one call that could hang (the fetch to Supabase, below)
 * already has its own bounded timeout; this is the last line of defence for
 * anything else -- a malformed request, an unexpected shape, anything.
 */
export default async function handler(req: Req, res: Res): Promise<void> {
  try {
    await run(req, res);
  } catch (error) {
    try {
      res.status(500).json({
        error: `Unexpected error creating a contributor account: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    } catch {
      // Response already sent, or res itself is broken. Nothing more to do.
    }
  }
}

async function run(req: Req, res: Res): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  const url = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '').trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!url || !key) {
    res.status(500).json({
      error:
        'This deployment has no database credentials, so it cannot create an ' +
        'account to attribute your contribution to. VITE_SUPABASE_URL and ' +
        'SUPABASE_SERVICE_ROLE_KEY are missing.',
    });
    return;
  }

  // Charged BEFORE the account is created, so a refused attempt costs the
  // caller a slot rather than nothing.
  let usage: { allowed: boolean; hour: number; day: number };
  try {
    usage = await charge(subjectFor(callerAddress(req.headers), key), url, key);
  } catch (error) {
    // FAIL CLOSED, but readably. A limiter that lets everything through when
    // it breaks is not a limiter.
    res.status(error instanceof LimiterUnavailable ? 504 : 500).json({
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (!usage.allowed) {
    res.status(429).json({
      error:
        'Too many new accounts have been created from this connection today. This ' +
        'limit exists to stop one person creating thousands. If you are seeing it ' +
        'and have not, wait an hour and try again.',
    });
    return;
  }

  const email = `anon-${randomSecret(16)}@${ANON_EMAIL_DOMAIN}`;
  const password = randomSecret(24);

  // Bounded so a hung upstream (a network blip between Vercel and Supabase, a
  // slow cold path, anything) becomes a fast, readable error instead of an
  // opaque platform-level 504 -- see UPSTREAM_TIMEOUT_MS above. No retry: a
  // healthy call is sub-second, so a real timeout here means something
  // unusual is happening upstream, and a second attempt would just as likely
  // hang again for the same reason, spending budget this endpoint does not
  // have rather than helping the caller.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      // email_confirm skips the confirmation mail that would never arrive at a
      // reserved domain, and would block the sign-in that follows.
      body: JSON.stringify({ email, password, email_confirm: true }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const timedOut = error instanceof Error && error.name === 'AbortError';
    res.status(timedOut ? 504 : 502).json({
      error: timedOut
        ? `The database took longer than ${UPSTREAM_TIMEOUT_MS / 1000}s to respond, so no ` +
          'account was created. This is usually momentary -- try saving again.'
        : `Could not reach the database to create a contributor account: ${
            error instanceof Error ? error.message : String(error)
          }`,
    });
    return;
  }

  if (!response.ok) {
    // Read the body BEFORE clearing the timeout: fetch resolves as soon as the
    // headers arrive, so a hung body would otherwise sit here unprotected
    // until Vercel's own gateway produced exactly the unreadable 504 this file
    // exists to prevent.
    const detail = await response.text();
    clearTimeout(timer);
    res.status(502).json({
      error: `The database refused to create a contributor account (${response.status}).`,
      detail: detail.slice(0, 400),
    });
    return;
  }

  // The browser signs itself in with these using the ordinary publishable key,
  // so refresh tokens and session storage stay entirely inside supabase-js
  // rather than being reimplemented here. The credentials are the account: they
  // are stored in that browser and nowhere else, and they are what Phase 4
  // turns into a recoverable identity.
  clearTimeout(timer);
  res.status(200).json({ email, password });
}
