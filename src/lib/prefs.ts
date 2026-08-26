/**
 * Everything the app remembers between visits, kept in this browser only.
 *
 * Ship presets live here rather than in the database because the database's
 * preset table is keyed by an account, and accounts arrive in Phase 4. The
 * consequence is stated in the UI rather than hidden: presets stay on this
 * device, and iOS Safari can clear them after about a week of non-use.
 *
 * Every read is defensive. Local storage is editable by hand, survives across
 * deploys of code that wrote a different shape, and throws outright in a
 * private window on some browsers. A bad value here must degrade to the
 * default, never crash the app on load.
 */

const KEY = 'wosb.prefs.v1';

export interface ShipPreset {
  /** Local id. Not a database row id — these never leave the device. */
  id: string;
  name: string;
  shipId: string;
  upgradeIds: string[];
  createdAt: string;
}

export interface RecentRoute {
  originPortId: string;
  destinationPortId: string;
  shipId: string;
  presetId: string | null;
  lastUsedAt: string;
}

export type PortPickerView = 'list' | 'map';

export interface Prefs {
  /** null until the user has chosen. Nothing is assumed on their behalf. */
  serverId: string | null;
  portPickerView: PortPickerView;
  presets: ShipPreset[];
  recentRoutes: RecentRoute[];
  /** Spending limit in tenths of gold, or null for unconstrained (SPEC 5.7). */
  availableGold: number | null;
}

export const DEFAULT_PREFS: Prefs = {
  serverId: null,
  portPickerView: 'list',
  presets: [],
  recentRoutes: [],
  availableGold: null,
};

const MAX_RECENT_ROUTES = 6;

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

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function parsePreset(value: unknown): ShipPreset | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const id = asString(row.id);
  const shipId = asString(row.shipId);
  if (!id || !shipId) return null;
  return {
    id,
    name: asString(row.name) ?? 'Unnamed preset',
    shipId,
    upgradeIds: asStringArray(row.upgradeIds),
    createdAt: asString(row.createdAt) ?? new Date(0).toISOString(),
  };
}

function parseRoute(value: unknown): RecentRoute | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const originPortId = asString(row.originPortId);
  const destinationPortId = asString(row.destinationPortId);
  const shipId = asString(row.shipId);
  if (!originPortId || !destinationPortId || !shipId) return null;
  return {
    originPortId,
    destinationPortId,
    shipId,
    presetId: asString(row.presetId),
    lastUsedAt: asString(row.lastUsedAt) ?? new Date(0).toISOString(),
  };
}

/** Coerce anything at all into a usable Prefs. Never throws. */
export function parsePrefs(raw: string | null): Prefs {
  if (!raw) return { ...DEFAULT_PREFS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PREFS };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_PREFS };
  const row = parsed as Record<string, unknown>;

  const gold = typeof row.availableGold === 'number' && Number.isFinite(row.availableGold)
    ? Math.max(0, Math.floor(row.availableGold))
    : null;

  return {
    serverId: asString(row.serverId),
    portPickerView: row.portPickerView === 'map' ? 'map' : 'list',
    presets: Array.isArray(row.presets)
      ? row.presets.map(parsePreset).filter((p): p is ShipPreset => p !== null)
      : [],
    recentRoutes: Array.isArray(row.recentRoutes)
      ? row.recentRoutes.map(parseRoute).filter((r): r is RecentRoute => r !== null)
      : [],
    availableGold: gold,
  };
}

export function loadPrefs(): Prefs {
  const store = storage();
  if (!store) return { ...DEFAULT_PREFS };
  try {
    return parsePrefs(store.getItem(KEY));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Persist. A full disk or a blocked store must not break the session. */
export function savePrefs(prefs: Prefs): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* Preferences are a convenience; losing them is not worth an error. */
  }
}

/**
 * Push a route to the front of the recent list, de-duplicated by both ports
 * and the ship, so re-running the same trip does not fill the list with copies.
 */
export function rememberRoute(routes: readonly RecentRoute[], route: RecentRoute): RecentRoute[] {
  const rest = routes.filter(
    (r) =>
      !(
        r.originPortId === route.originPortId &&
        r.destinationPortId === route.destinationPortId &&
        r.shipId === route.shipId
      ),
  );
  return [route, ...rest].slice(0, MAX_RECENT_ROUTES);
}

/** A unique-enough local id without pulling in a dependency for it. */
export function newLocalId(): string {
  const globalCrypto = typeof crypto === 'undefined' ? null : crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
