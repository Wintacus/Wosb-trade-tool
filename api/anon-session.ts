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

export const config = { maxDuration: 15 };

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

export default async function handler(req: Req, res: Res): Promise<void> {
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

  const response = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    // email_confirm skips the confirmation mail that would never arrive at a
    // reserved domain, and would block the sign-in that follows.
    body: JSON.stringify({ email, password, email_confirm: true }),
  });

  if (!response.ok) {
    const detail = await response.text();
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
  res.status(200).json({ email, password });
}
