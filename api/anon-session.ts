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
const UPSTREAM_TIMEOUT_MS = 8_000;

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
 * Best-effort flood protection.
 *
 * Serverless instances are not shared, so this only limits a burst that lands
 * on the same warm instance -- it is a speed bump, not a wall. It is here
 * because each call creates a permanent auth user and the endpoint is
 * unauthenticated by definition. Real per-account rate limiting arrives with
 * the OCR upload endpoint, which spends money per request (SPEC.md 7.2.4).
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_WINDOW = 5;
const recent = new Map<string, number[]>();

export function rateLimited(key: string, now = Date.now()): boolean {
  const hits = (recent.get(key) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  hits.push(now);
  recent.set(key, hits);
  // Keep the map from growing without bound on a long-lived instance.
  if (recent.size > 500) {
    for (const [id, times] of recent) {
      if (times.every((at) => now - at >= RATE_WINDOW_MS)) recent.delete(id);
    }
  }
  return hits.length > RATE_MAX_PER_WINDOW;
}

/** A credential nobody chose and nobody has to remember. */
function randomSecret(bytes = 24): string {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return Array.from(raw, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function callerKey(req: Req): string {
  const forwarded = req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (value ?? 'unknown').split(',')[0]!.trim();
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

  if (rateLimited(callerKey(req))) {
    res.status(429).json({ error: 'Too many new accounts from here. Wait a minute and try again.' });
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
