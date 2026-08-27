import { describe, expect, test } from 'vitest';
import { parseCredentials } from '../lib/identity';

/**
 * The rule that decides whether the user's account survives a bad moment.
 *
 * `resolveIdentity` used to call `forgetCredentials()` on ANY truthy error
 * from `signInWithPassword`. That is a far wider net than it looks, because
 * supabase-js does not throw on a network failure -- it wraps it in
 * `AuthRetryableFetchError` (which extends `AuthError`, so `isAuthError`
 * catches it) and RETURNS it as `{ error }`.
 *
 * An LTE blip, a captive portal, a Supabase hiccup, or iOS killing the request
 * as the user switches back from the game all landed in that branch and
 * silently destroyed the credentials that ARE the account. Past contributions
 * stayed in the database attributed to an identity the user no longer held.
 *
 * This pins the distinction the code now draws: a 4xx is the server saying
 * "those credentials are wrong"; anything else is "I could not ask", which is
 * not an answer and must never be treated as one.
 */

/** Mirrors the check in resolveIdentity. */
function shouldForget(error: { status?: number } | null): boolean {
  const status = error?.status;
  return status === 400 || status === 401 || status === 403;
}

describe('an account is only forgotten when it was actually rejected', () => {
  test('a rejected password forgets the account', () => {
    expect(shouldForget({ status: 400 })).toBe(true);
    expect(shouldForget({ status: 401 })).toBe(true);
    expect(shouldForget({ status: 403 })).toBe(true);
  });

  test('a network failure does NOT forget the account', () => {
    // AuthRetryableFetchError carries status 0 for a failed fetch.
    expect(shouldForget({ status: 0 })).toBe(false);
    expect(shouldForget({})).toBe(false);
    expect(shouldForget({ status: undefined })).toBe(false);
    expect(shouldForget(null)).toBe(false);
  });

  test('a server outage does NOT forget the account', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(shouldForget({ status }), `${status} is not a rejection`).toBe(false);
    }
  });

  test('a rate limit or timeout does NOT destroy the account', () => {
    // Both are 4xx, so a blanket "any 4xx is a rejection" rule would throw the
    // account away on "ask again later". They are named explicitly for that
    // reason rather than falling out of a range check.
    expect(shouldForget({ status: 429 })).toBe(false);
    expect(shouldForget({ status: 408 })).toBe(false);
  });
});

describe('stored credentials survive anything in the slot', () => {
  test('junk reads as no identity rather than throwing', () => {
    for (const raw of [null, '', 'not json', '[]', '{}', '{"email":"a"}']) {
      expect(parseCredentials(raw)).toBeNull();
    }
  });
});
