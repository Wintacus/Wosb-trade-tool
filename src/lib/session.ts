/**
 * The work in progress, kept across a page reload.
 *
 * This exists because of the single worst bug this project has shipped, and
 * it was invisible to every test for weeks.
 *
 * The route, the ship and every price typed into the entry screen lived in
 * React state and nowhere else. React state does not survive a page reload —
 * and iOS Safari reloads a backgrounded tab whenever it wants the memory,
 * which is long-standing, well-documented behaviour nobody can turn off.
 *
 * Now look at what this app is actually for. You stand in a port, read a
 * price off the game, switch to this tool, type it in, switch back for the
 * next one. **Every single switch was a chance to lose everything** — both
 * ports, the ship, and every number already entered — dumping the user back
 * at step 1. It reads exactly like the app randomly resetting itself, because
 * from the outside that is precisely what it is.
 *
 * A desktop browser tab is never discarded, so no amount of clicking through
 * the app in Chromium would ever show this. Only reloading does. There is a
 * test that reloads (`src/test/session.test.ts`, plus the browser check in
 * `scripts/verify-ui.mjs`) and it must stay.
 */

const STORAGE_KEY = 'wosb.session.v1';

/**
 * How long a resumed session stays valid.
 *
 * Long enough to survive a play session and the phone being put down for a
 * while; short enough that opening the app the next day starts fresh rather
 * than resuming a route whose prices have all gone stale.
 */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

export type SessionStep = 'origin' | 'destination' | 'ship' | 'results';

export interface SessionShipChoice {
  shipId: string;
  presetId: string | null;
  upgradeIds: string[];
}

/** One row of the price-entry sheet, exactly as typed. */
export interface SessionDraft {
  buyText: string;
  sellText: string;
  stockText: string;
  /**
   * What a screenshot read gave for this row, if one filled it in.
   *
   * Kept beside the current text rather than replacing it so the review screen
   * can say which numbers a person typed and which a machine proposed, and so
   * `ocr_corrections` can record what was changed and to what (SPEC.md 7.2).
   * Absent on every hand-typed row.
   */
  ocr?: OcrOrigin;
}

/** The three values a screenshot read proposed, exactly as it reported them. */
export interface OcrOrigin {
  buyText: string;
  sellText: string;
  stockText: string;
}

export interface SessionState {
  /**
   * Which server this work belongs to.
   *
   * Without it a session saved on North America restored identically onto
   * Europe, and prices read off one economy were saved into the other with a
   * success banner. "Servers are separate economies... mixing NA and EU data
   * produces garbage" — so the stamp is what makes that detectable at all.
   */
  serverId: string | null;
  step: SessionStep;
  originId: string | null;
  destinationId: string | null;
  shipChoice: SessionShipChoice | null;
  /** Whether the price-entry sheet was open, and at which port. */
  entryOpen: boolean;
  entryPortId: string | null;
  /** Prices typed but not yet saved, keyed by port id then good id. */
  drafts: Record<string, Record<string, SessionDraft>>;
  savedAt: number;
}

export const EMPTY_SESSION: SessionState = {
  serverId: null,
  step: 'origin',
  originId: null,
  destinationId: null,
  shipChoice: null,
  entryOpen: false,
  entryPortId: null,
  drafts: {},
  savedAt: 0,
};

const STEPS: readonly SessionStep[] = ['origin', 'destination', 'ship', 'results'];

function storage(): Storage | null {
  try {
    // Safari in private mode has thrown on access, not just on write.
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseOcrOrigin(value: unknown): OcrOrigin | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  return {
    buyText: typeof row.buyText === 'string' ? row.buyText : '',
    sellText: typeof row.sellText === 'string' ? row.sellText : '',
    stockText: typeof row.stockText === 'string' ? row.stockText : '',
  };
}

function parseDraft(value: unknown): SessionDraft | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const draft: SessionDraft = {
    buyText: typeof row.buyText === 'string' ? row.buyText : '',
    sellText: typeof row.sellText === 'string' ? row.sellText : '',
    stockText: typeof row.stockText === 'string' ? row.stockText : '',
  };
  const ocr = parseOcrOrigin(row.ocr);
  if (ocr) draft.ocr = ocr;
  // An all-blank row is not worth restoring; it is indistinguishable from
  // never having been touched.
  return draft.buyText || draft.sellText || draft.stockText ? draft : null;
}

function parseDrafts(value: unknown): Record<string, Record<string, SessionDraft>> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, Record<string, SessionDraft>> = {};
  for (const [portId, rows] of Object.entries(value as Record<string, unknown>)) {
    if (typeof rows !== 'object' || rows === null) continue;
    const perGood: Record<string, SessionDraft> = {};
    for (const [goodId, row] of Object.entries(rows as Record<string, unknown>)) {
      const draft = parseDraft(row);
      if (draft) perGood[goodId] = draft;
    }
    if (Object.keys(perGood).length > 0) out[portId] = perGood;
  }
  return out;
}

/**
 * Coerce anything at all into a usable session. Never throws.
 *
 * Storage can hold a half-written value, a session from an older build, or
 * something another tab wrote. None of that may be allowed to crash the app
 * on startup — a crash here would lock the user out of the whole tool with no
 * way back except clearing site data, which they cannot easily do on a phone.
 */
export function parseSession(raw: string | null, now = Date.now()): SessionState {
  if (!raw) return EMPTY_SESSION;
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null) return EMPTY_SESSION;
    const row = value as Record<string, unknown>;

    const savedAt = typeof row.savedAt === 'number' ? row.savedAt : 0;
    // A session from a previous day resumes into prices that are all stale.
    // Starting fresh is the honest default.
    if (!savedAt || now - savedAt > MAX_AGE_MS) return EMPTY_SESSION;

    const step = STEPS.includes(row.step as SessionStep)
      ? (row.step as SessionStep)
      : 'origin';

    let shipChoice: SessionShipChoice | null = null;
    if (typeof row.shipChoice === 'object' && row.shipChoice !== null) {
      const choice = row.shipChoice as Record<string, unknown>;
      const shipId = asString(choice.shipId);
      if (shipId) {
        shipChoice = {
          shipId,
          presetId: asString(choice.presetId),
          upgradeIds: Array.isArray(choice.upgradeIds)
            ? choice.upgradeIds.filter((v): v is string => typeof v === 'string')
            : [],
        };
      }
    }

    return {
      serverId: asString(row.serverId),
      step,
      originId: asString(row.originId),
      destinationId: asString(row.destinationId),
      shipChoice,
      entryOpen: row.entryOpen === true,
      entryPortId: asString(row.entryPortId),
      drafts: parseDrafts(row.drafts),
      savedAt,
    };
  } catch {
    return EMPTY_SESSION;
  }
}

export function loadSession(now = Date.now()): SessionState {
  return parseSession(storage()?.getItem(STORAGE_KEY) ?? null, now);
}

/**
 * The session, but only if it belongs to the server now selected.
 *
 * A route and a sheet full of typed prices are meaningless — worse, actively
 * misleading — against a different economy. Restoring them onto the wrong
 * server is how a price read on North America ended up saved as Europe's.
 * A session with no stamp at all predates this and is not trusted either.
 */
export function loadSessionForServer(
  serverId: string | null,
  now = Date.now(),
): SessionState {
  const session = loadSession(now);
  if (!serverId || session.serverId !== serverId) return EMPTY_SESSION;
  return session;
}

export function saveSession(state: Omit<SessionState, 'savedAt'>, now = Date.now()): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ ...state, savedAt: now }));
  } catch {
    // A full or blocked storage must never break the app. The cost is losing
    // the resume, which is exactly where we were before this existed.
  }
}

export function clearSession(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}

/**
 * Drop the drafts for one port, once they have actually been saved.
 *
 * Keeping them would re-offer numbers already in the database as if they were
 * still unsaved, and the user would have no way to tell the difference.
 */
export function withoutPortDrafts(
  drafts: Record<string, Record<string, SessionDraft>>,
  portId: string,
): Record<string, Record<string, SessionDraft>> {
  const next = { ...drafts };
  delete next[portId];
  return next;
}
