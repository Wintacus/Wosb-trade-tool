import { supabase } from './supabase';

/**
 * The invisible account a contribution is attributed to.
 *
 * The person using this app never signs up, never sees a password, and is
 * never asked to log in. The first time they save an observation, an account
 * is created for them in the background and remembered in this browser.
 *
 * It exists because the database requires it. Every price submission carries a
 * `submitted_by`, and the row-level security policy refuses an insert from a
 * signed-out visitor. That is what makes Phase 4's consensus weighting,
 * outlier detection and moderation possible at all -- an anonymous free-for-all
 * would leave nothing to weigh or moderate.
 *
 * The credentials live in this browser's local storage and nowhere else. They
 * are not a secret worth stealing -- the account can only add observations that
 * everyone can already read -- but they ARE the account, so losing them means
 * losing authorship of past contributions, not the contributions themselves.
 * SPEC.md 8 makes that recoverable: showing them as a copyable token, and
 * upgrading this same account to a real email and password without moving any
 * data, because the auth user id never changes.
 */

const STORAGE_KEY = 'wosb.identity.v1';

export interface AnonCredentials {
  email: string;
  password: string;
}

function storage(): Storage | null {
  try {
    // Safari in private mode has thrown on access, not just on write.
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Reads stored credentials, tolerating anything at all in the slot. */
export function parseCredentials(raw: string | null): AnonCredentials | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null) return null;
    const row = value as Record<string, unknown>;
    const email = typeof row.email === 'string' ? row.email : '';
    const password = typeof row.password === 'string' ? row.password : '';
    return email && password ? { email, password } : null;
  } catch {
    return null;
  }
}

export function loadCredentials(): AnonCredentials | null {
  return parseCredentials(storage()?.getItem(STORAGE_KEY) ?? null);
}

export function saveCredentials(credentials: AnonCredentials): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(credentials));
  } catch {
    // A full or blocked storage is not a reason to lose the submission the
    // user is in the middle of making. The session still works for this visit;
    // only the ability to be recognised next time is lost.
  }
}

export function forgetCredentials(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}

/** One call to /api/anon-session. Throws with a readable message. */
async function requestCredentials(): Promise<AnonCredentials> {
  const response = await fetch('/api/anon-session', { method: 'POST' });
  const body = (await response.json().catch(() => ({}))) as { email?: string; password?: string; error?: string };
  if (!response.ok || !body.email || !body.password) {
    throw new Error(body.error ?? `Could not create a contributor account (${response.status}).`);
  }
  return { email: body.email, password: body.password };
}

/**
 * Asks the server for a fresh account, retrying once on failure.
 *
 * The endpoint now bounds its own slow path to a few seconds rather than
 * hanging (see api/anon-session.ts), so a single flaky call -- a momentary
 * blip, a cold start -- is worth one more try rather than failing the user's
 * very first save outright with no second chance. Retried immediately, with
 * no backoff: two failures in a row means something is actually wrong, and
 * that is reported as-is rather than retried again.
 */
export async function mintCredentials(): Promise<AnonCredentials> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await requestCredentials();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function client() {
  if (!supabase) {
    throw new Error(
      'The app is not connected to its database, so nothing can be saved. ' +
        'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are missing from this deployment.',
    );
  }
  return supabase;
}

/**
 * A profile row must exist before a submission can reference it.
 *
 * `price_submissions.submitted_by` is a foreign key to `profiles`, and nothing
 * creates that row automatically, so the first save would otherwise fail on a
 * constraint the user can do nothing about. The policy on `profiles` allows a
 * signed-in user to insert exactly their own row, which is what this does.
 */
async function ensureProfile(userId: string): Promise<void> {
  const { error } = await client()
    .from('profiles')
    .upsert({ id: userId }, { onConflict: 'id', ignoreDuplicates: true });
  if (error) throw new Error(`Could not set up your contributor profile: ${error.message}`);
}

let inFlight: Promise<string> | null = null;

/**
 * Returns the signed-in user id, creating the account if this is the first save.
 *
 * Concurrent callers share one attempt: two rows saved at once must not mint
 * two accounts and race to overwrite each other's credentials.
 */
export function ensureIdentity(): Promise<string> {
  if (!inFlight) {
    inFlight = resolveIdentity().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function resolveIdentity(): Promise<string> {
  const auth = client().auth;

  const existing = await auth.getSession();
  const sessionUser = existing.data.session?.user?.id;
  if (sessionUser) return sessionUser;

  const stored = loadCredentials();
  if (stored) {
    const { data, error } = await auth.signInWithPassword(stored);
    if (!error && data.user) {
      await ensureProfile(data.user.id);
      return data.user.id;
    }
    // Only forget the account when the server actually REJECTED it.
    //
    // This used to discard the credentials on any truthy error, which is a
    // much wider net than it looks: supabase-js does not throw on a network
    // failure, it wraps it in AuthRetryableFetchError and RETURNS it here.
    // An LTE blip, a captive portal, a Supabase hiccup, or iOS killing the
    // request as the user switches back from the game -- every one of those
    // landed in this branch, silently destroyed the credentials that ARE the
    // account, and minted a new one. Past contributions stayed in the
    // database attributed to an identity the user no longer held, and SPEC 8's
    // "upgrade this account without losing data" stopped being possible.
    //
    // Only these mean "those credentials are wrong". Everything else --
    // including a 429 rate limit and a 408 timeout, which are 4xx but say
    // "ask again later" rather than "you are not that account" -- is "could
    // not ask", which is not an answer and must not be acted on.
    const status = (error as { status?: number } | null)?.status;
    const rejected = status === 400 || status === 401 || status === 403;
    if (!rejected) {
      throw new Error(
        'Could not reach the sign-in service, so your saved contributor ' +
          'account was left alone. Check your connection and try again.',
      );
    }
    forgetCredentials();
  }

  const fresh = await mintCredentials();
  const { data, error } = await auth.signInWithPassword(fresh);
  if (error || !data.user) {
    throw new Error(
      `An account was created but could not be signed in to: ${error?.message ?? 'no session returned'}`,
    );
  }
  saveCredentials(fresh);
  await ensureProfile(data.user.id);
  return data.user.id;
}
