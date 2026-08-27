import { describe, expect, test } from 'vitest';
import {
  EMPTY_SESSION,
  parseSession,
  withoutPortDrafts,
  type SessionState,
} from '../lib/session';

/**
 * Resuming work after the tab is reloaded.
 *
 * This covers the worst bug this project has shipped. The route, the ship and
 * every typed price lived only in React state, so a page reload wiped the
 * lot and dumped the user back at step 1. iOS Safari reloads a backgrounded
 * tab whenever it wants the memory — and this tool's whole workflow is
 * switching to the game to read a price and switching back. It looked exactly
 * like the app resetting itself at random, and it was reported that way three
 * times before anyone reloaded a page to check.
 *
 * The browser half of this lives in `scripts/verify-ui.mjs`, which drives the
 * real app, reloads it, and asserts the route survives. Both must stay.
 */

function complete(overrides: Partial<SessionState> = {}): SessionState {
  return {
    step: 'results',
    originId: 'fiji',
    destinationId: 'st_john',
    shipChoice: { shipId: 'fluyt', presetId: null, upgradeIds: [] },
    entryOpen: false,
    entryPortId: null,
    drafts: {},
    savedAt: Date.now(),
    ...overrides,
  };
}

describe('a reload resumes where the user left off', () => {
  test('the whole route and ship come back', () => {
    const restored = parseSession(JSON.stringify(complete()));
    expect(restored.step).toBe('results');
    expect(restored.originId).toBe('fiji');
    expect(restored.destinationId).toBe('st_john');
    expect(restored.shipChoice?.shipId).toBe('fluyt');
  });

  test('prices typed but not yet saved come back', () => {
    const stored = complete({
      entryOpen: true,
      entryPortId: 'fiji',
      drafts: { fiji: { sugar: { buyText: '', sellText: '18.9', stockText: '40' } } },
    });
    const restored = parseSession(JSON.stringify(stored));
    expect(restored.entryOpen).toBe(true);
    expect(restored.entryPortId).toBe('fiji');
    expect(restored.drafts.fiji?.sugar).toEqual({
      buyText: '',
      sellText: '18.9',
      stockText: '40',
    });
  });

  test('an all-blank row is not restored — it is the same as untouched', () => {
    const stored = complete({
      drafts: { fiji: { sugar: { buyText: '', sellText: '', stockText: '' } } },
    });
    expect(parseSession(JSON.stringify(stored)).drafts).toEqual({});
  });
});

describe('a resumed session is never allowed to break the app', () => {
  test('junk in storage reads as a fresh start rather than throwing', () => {
    // A crash here would lock the user out of the whole tool on startup, with
    // no way back except clearing site data — which is hard on a phone.
    for (const raw of [null, '', 'not json', '[]', '{}', '{"step":42}', 'null']) {
      expect(() => parseSession(raw)).not.toThrow();
    }
    expect(parseSession('not json')).toEqual(EMPTY_SESSION);
  });

  test('an unknown step falls back to the beginning', () => {
    const restored = parseSession(JSON.stringify(complete({ step: 'nonsense' as never })));
    expect(restored.step).toBe('origin');
  });

  test('a ship choice with no ship id is dropped', () => {
    const raw = JSON.stringify({ ...complete(), shipChoice: { presetId: 'x', upgradeIds: [] } });
    expect(parseSession(raw).shipChoice).toBeNull();
  });

  test('yesterday\'s session is not resumed — its prices are all stale', () => {
    const old = complete({ savedAt: Date.now() - 13 * 60 * 60 * 1000 });
    expect(parseSession(JSON.stringify(old))).toEqual(EMPTY_SESSION);
  });

  test('a session with no timestamp is not trusted', () => {
    const raw = JSON.stringify({ ...complete(), savedAt: undefined });
    expect(parseSession(raw)).toEqual(EMPTY_SESSION);
  });

  test('a recent session is resumed', () => {
    const recent = complete({ savedAt: Date.now() - 60_000 });
    expect(parseSession(JSON.stringify(recent)).originId).toBe('fiji');
  });
});

describe('drafts are dropped once they reach the database', () => {
  test('saving one port leaves other ports alone', () => {
    const drafts = {
      fiji: { sugar: { buyText: '', sellText: '40', stockText: '' } },
      st_john: { silk: { buyText: '', sellText: '88', stockText: '' } },
    };
    const after = withoutPortDrafts(drafts, 'fiji');
    expect(after.fiji).toBeUndefined();
    expect(after.st_john).toBeDefined();
    // The original is untouched: React state must not be mutated in place.
    expect(drafts.fiji).toBeDefined();
  });
});
