import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, parsePrefs, rememberRoute, type RecentRoute } from '../lib/prefs';

function route(origin: string, destination: string, ship: string): RecentRoute {
  return {
    originPortId: origin,
    destinationPortId: destination,
    shipId: ship,
    presetId: null,
    lastUsedAt: '2026-08-24T00:00:00.000Z',
  };
}

describe('stored preferences', () => {
  it('returns defaults for nothing stored', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('')).toEqual(DEFAULT_PREFS);
  });

  it('survives corrupt storage rather than crashing the app on load', () => {
    // Local storage is hand-editable and outlives the code that wrote it, so a
    // shape mismatch must degrade to the default, never throw during boot.
    expect(parsePrefs('{oh no')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('"a string"')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('null')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('[1,2,3]').presets).toEqual([]);
  });

  it('never invents a server: unset stays null', () => {
    // Picking one on the user's behalf would silently show another economy's
    // prices, which is exactly the mixing the schema is scoped to prevent.
    expect(parsePrefs('{}').serverId).toBeNull();
    expect(parsePrefs('{"serverId":""}').serverId).toBeNull();
    expect(parsePrefs('{"serverId":"eu"}').serverId).toBe('eu');
  });

  it('drops presets that are missing the fields a preset needs', () => {
    const raw = JSON.stringify({
      presets: [
        { id: 'a', name: 'Fluyt', shipId: 'fluyt', upgradeIds: ['hold1'] },
        { id: 'b', name: 'no ship id' },
        'not an object',
        { shipId: 'orphan' },
      ],
    });
    const prefs = parsePrefs(raw);
    expect(prefs.presets.map((p) => p.id)).toEqual(['a']);
    expect(prefs.presets[0]!.upgradeIds).toEqual(['hold1']);
  });

  it('keeps only string upgrade ids, whatever was stored', () => {
    const raw = JSON.stringify({
      presets: [{ id: 'a', shipId: 's', upgradeIds: ['ok', 3, null, { x: 1 }] }],
    });
    expect(parsePrefs(raw).presets[0]!.upgradeIds).toEqual(['ok']);
  });

  it('clamps a nonsense gold limit instead of feeding it to the calculator', () => {
    expect(parsePrefs('{"availableGold":-50}').availableGold).toBe(0);
    expect(parsePrefs('{"availableGold":12.7}').availableGold).toBe(12);
    expect(parsePrefs('{"availableGold":"lots"}').availableGold).toBeNull();
    expect(parsePrefs('{"availableGold":null}').availableGold).toBeNull();
  });

  it('accepts only the two picker views', () => {
    expect(parsePrefs('{"portPickerView":"map"}').portPickerView).toBe('map');
    expect(parsePrefs('{"portPickerView":"hologram"}').portPickerView).toBe('list');
  });
});

describe('recent routes', () => {
  it('puts the newest first and de-duplicates the same trip', () => {
    let routes = rememberRoute([], route('a', 'b', 'fluyt'));
    routes = rememberRoute(routes, route('c', 'd', 'fluyt'));
    routes = rememberRoute(routes, route('a', 'b', 'fluyt'));
    expect(routes).toHaveLength(2);
    expect(routes[0]!.originPortId).toBe('a');
  });

  it('treats a different ship on the same ports as a different route', () => {
    let routes = rememberRoute([], route('a', 'b', 'fluyt'));
    routes = rememberRoute(routes, route('a', 'b', 'brig'));
    expect(routes).toHaveLength(2);
  });

  it('caps the list so it cannot grow without limit', () => {
    let routes: RecentRoute[] = [];
    for (let i = 0; i < 20; i += 1) routes = rememberRoute(routes, route(`p${i}`, 'x', 's'));
    expect(routes).toHaveLength(6);
    expect(routes[0]!.originPortId).toBe('p19');
  });
});
