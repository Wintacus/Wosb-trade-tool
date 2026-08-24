import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import { effectiveShipStats, usableHold } from '../domain/ships';
import type { EffectiveShipStats } from '../domain/ships';
import type { Ship, Upgrade } from '../domain/types';
import { newLocalId } from '../lib/prefs';
import type { ShipPreset } from '../lib/prefs';
import { Button, Caveat, Panel } from './Ui';

/**
 * Ship and preset picker (SPEC 6.5).
 *
 * Two lists, in the order the user actually needs them: the ships they have
 * saved, then every ship in the database. A preset with zero upgrades is a
 * perfectly good preset — the game lets you sail an unupgraded hull, so the UI
 * must never nag about one being "incomplete".
 *
 * Nothing here knows a single game value. Rates, classes, holds, speeds and
 * upgrade categories are all read off the rows handed in (CLAUDE.md rule 2),
 * which is why even the search placeholder counts the list rather than saying
 * "38 ships" — the day a patch adds one, this text stays true.
 */

/** How long the undo offer stays on screen after a delete. */
const UNDO_MS = 8000;

interface UndoState {
  preset: ShipPreset;
  /** Where it sat in the list, so undo puts it back rather than at the end. */
  index: number;
  /** Whether it was the active choice, so undo can also restore the selection. */
  wasSelected: boolean;
}

interface Draft {
  presetId: string;
  name: string;
  upgradeIds: string[];
}

/** A preset resolved against the current database rows. */
interface ResolvedPreset {
  preset: ShipPreset;
  /** null when the preset points at a ship that is no longer in the database. */
  ship: Ship | null;
  upgrades: Upgrade[];
  /** Upgrade ids the preset still carries that no longer resolve to a row. */
  missingUpgradeIds: string[];
  stats: EffectiveShipStats | null;
}

function formatNumber(value: number): string {
  // Percentage upgrades can leave a fractional speed. Two decimals is as much
  // precision as the in-game HUD shows, and more would imply we know more.
  return Number.isInteger(value)
    ? value.toLocaleString()
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    // Strip accents so "cerf" finds "Le Cerf" and "esperance" finds "Espérance".
    // Typing an accented character on a phone keyboard is a real obstacle.
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

function searchShips(ships: readonly Ship[], query: string): Ship[] {
  const needle = normalise(query);
  const matches =
    needle === ''
      ? [...ships]
      : ships.filter(
          (ship) =>
            normalise(ship.name).includes(needle) || normalise(ship.shipClass).includes(needle),
        );
  // Rate ascending puts the biggest hulls first, which is the order the in-game
  // shipyard uses; name breaks ties so the list never reshuffles between renders.
  return matches.sort((a, b) => a.rate - b.rate || a.name.localeCompare(b.name));
}

/** Group upgrades by their own category, with a home for uncategorised rows. */
function groupUpgrades(upgrades: readonly Upgrade[]): [string, Upgrade[]][] {
  const groups = new Map<string, Upgrade[]>();
  for (const upgrade of upgrades) {
    const key = upgrade.category ?? 'Other';
    const bucket = groups.get(key);
    if (bucket) bucket.push(upgrade);
    else groups.set(key, [upgrade]);
  }
  for (const bucket of groups.values()) bucket.sort((a, b) => a.name.localeCompare(b.name));
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function StatsLine({ stats, verified }: { stats: EffectiveShipStats; verified: boolean }) {
  return (
    <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
      <span>
        Hold <span className="font-medium tabular-nums text-slate-200">{formatNumber(usableHold(stats))}</span>
      </span>
      <span>
        Base speed{' '}
        <span className="font-medium tabular-nums text-slate-200">
          {stats.speed === null ? 'unknown' : formatNumber(stats.speed)}
        </span>
      </span>
      {stats.cruiseSpeedBonus !== 0 ? (
        // Sails raise the cruise ceiling, not base speed, so it is shown apart
        // from the base figure rather than folded into it.
        <span>
          Cruise bonus{' '}
          <span className="font-medium tabular-nums text-slate-200">
            +{formatNumber(stats.cruiseSpeedBonus)}
          </span>
        </span>
      ) : null}
      {!verified ? (
        <span className="rounded-full border border-amber-400/40 px-2 py-0.5 text-amber-200">
          ⚠ Unverified stats
        </span>
      ) : null}
    </span>
  );
}

export function ShipPicker({
  ships,
  upgrades,
  presets,
  onPresetsChange,
  selectedShipId,
  selectedPresetId,
  onSelect,
}: {
  ships: readonly Ship[];
  upgrades: readonly Upgrade[];
  presets: readonly ShipPreset[];
  onPresetsChange: (next: ShipPreset[]) => void;
  selectedShipId: string | null;
  selectedPresetId: string | null;
  onSelect: (choice: { shipId: string; presetId: string | null; upgradeIds: string[] }) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [namingShipId, setNamingShipId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [undo, setUndo] = useState<UndoState | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shipsById = useMemo(() => new Map(ships.map((ship) => [ship.id, ship])), [ships]);
  const upgradesById = useMemo(() => new Map(upgrades.map((u) => [u.id, u])), [upgrades]);
  const matches = useMemo(() => searchShips(ships, query), [ships, query]);
  const upgradeGroups = useMemo(() => groupUpgrades(upgrades), [upgrades]);

  /**
   * Resolve every preset against the database on each render.
   *
   * A preset is a bag of ids stored on this device; the ships and upgrades it
   * names live in a database that gets patched. Rather than quietly discarding
   * a preset whose ship has vanished — which would look like data loss — the
   * row survives and says what is missing (SPEC 6.6's spirit: say it plainly).
   */
  const resolved = useMemo<ResolvedPreset[]>(
    () =>
      presets.map((preset) => {
        const ship = shipsById.get(preset.shipId) ?? null;
        const found: Upgrade[] = [];
        const missingUpgradeIds: string[] = [];
        for (const id of preset.upgradeIds) {
          const upgrade = upgradesById.get(id);
          if (upgrade) found.push(upgrade);
          else missingUpgradeIds.push(id);
        }
        return {
          preset,
          ship,
          upgrades: found,
          missingUpgradeIds,
          stats: ship ? effectiveShipStats(ship, found) : null,
        };
      }),
    [presets, shipsById, upgradesById],
  );

  const clearUndoTimer = useCallback(() => {
    if (undoTimer.current !== null) {
      clearTimeout(undoTimer.current);
      undoTimer.current = null;
    }
  }, []);

  // The undo offer is a timer, and a timer that outlives the component would
  // call setState on an unmounted tree. Cleared on unmount and whenever a new
  // delete replaces the old offer.
  useEffect(() => clearUndoTimer, [clearUndoTimer]);

  function startEditing(entry: ResolvedPreset) {
    setPendingDeleteId(null);
    setDraft({
      presetId: entry.preset.id,
      name: entry.preset.name,
      // Missing upgrade ids are deliberately dropped from the draft: saving the
      // edit is the natural moment to let go of an upgrade the game removed.
      upgradeIds: entry.upgrades.map((u) => u.id),
    });
  }

  function saveDraft(entry: ResolvedPreset) {
    if (!draft) return;
    const name = draft.name.trim() || entry.preset.name;
    const next = presets.map((p) =>
      p.id === entry.preset.id ? { ...p, name, upgradeIds: [...draft.upgradeIds] } : p,
    );
    onPresetsChange(next);
    setDraft(null);
    // Editing the preset that is currently driving the calculation must update
    // the calculation too — otherwise the hold on screen and the hold used by
    // the cargo plan disagree, and the plan is the one that is wrong.
    if (selectedPresetId === entry.preset.id) {
      onSelect({
        shipId: entry.preset.shipId,
        presetId: entry.preset.id,
        upgradeIds: [...draft.upgradeIds],
      });
    }
  }

  function toggleDraftUpgrade(upgradeId: string, checked: boolean) {
    setDraft((current) => {
      if (!current) return current;
      const ids = checked
        ? [...new Set([...current.upgradeIds, upgradeId])]
        : current.upgradeIds.filter((id) => id !== upgradeId);
      return { ...current, upgradeIds: ids };
    });
  }

  function deletePreset(entry: ResolvedPreset) {
    const index = presets.findIndex((p) => p.id === entry.preset.id);
    onPresetsChange(presets.filter((p) => p.id !== entry.preset.id));
    setPendingDeleteId(null);
    if (draft?.presetId === entry.preset.id) setDraft(null);

    const wasSelected = selectedPresetId === entry.preset.id;
    if (wasSelected && entry.ship) {
      // Leaving a deleted preset selected would leave the calculator quoting an
      // upgraded hold that no longer has a preset behind it. Falling back to the
      // bare ship is the honest reading, and undo restores the upgrades.
      onSelect({ shipId: entry.ship.id, presetId: null, upgradeIds: [] });
    }

    clearUndoTimer();
    setUndo({ preset: entry.preset, index: index < 0 ? presets.length : index, wasSelected });
    undoTimer.current = setTimeout(() => {
      undoTimer.current = null;
      setUndo(null);
    }, UNDO_MS);
  }

  function runUndo() {
    if (!undo) return;
    const next = [...presets];
    next.splice(Math.min(undo.index, next.length), 0, undo.preset);
    onPresetsChange(next);
    if (undo.wasSelected) {
      onSelect({
        shipId: undo.preset.shipId,
        presetId: undo.preset.id,
        upgradeIds: [...undo.preset.upgradeIds],
      });
    }
    clearUndoTimer();
    setUndo(null);
  }

  function createPreset(ship: Ship) {
    const name = newName.trim() || ship.name;
    const preset: ShipPreset = {
      id: newLocalId(),
      name,
      shipId: ship.id,
      // A new preset starts bare. Upgrades are added by editing it, which keeps
      // creating one to a single tap for the common case of an unupgraded hull.
      upgradeIds: [],
      createdAt: new Date().toISOString(),
    };
    onPresetsChange([...presets, preset]);
    setNamingShipId(null);
    setNewName('');
    onSelect({ shipId: ship.id, presetId: preset.id, upgradeIds: [] });
  }

  return (
    <div className="space-y-4">
      {/* One caveat for the whole screen, not one per row: repeating it beside
          every ship trains the user to stop reading it. */}
      <Caveat>
        Speed shown is <strong>base</strong> speed. Real speed varies with wind, sail setting and how
        heavily you are loaded, so treat it as a comparison between ships rather than a prediction.
      </Caveat>

      <Panel>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold text-slate-100">Your ships</h2>
          <p className="text-xs text-slate-500">
            Presets are saved on this device only — they will not appear on another phone or browser.
          </p>
        </div>

        {undo ? (
          <div
            role="status"
            className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-700 bg-slate-800/60 px-3 py-2"
          >
            <span className="text-sm text-slate-200">Deleted “{undo.preset.name}”.</span>
            <Button variant="ghost" onClick={runUndo}>
              Undo
            </Button>
          </div>
        ) : null}

        {resolved.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">
            No saved ships yet. Pick one below and tap <strong>Save as preset</strong> to keep it,
            with or without upgrades.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-800/80">
            {resolved.map((entry) => {
              const isSelected = selectedPresetId === entry.preset.id;
              const isEditing = draft?.presetId === entry.preset.id;
              const upgradeCount = entry.upgrades.length;
              return (
                <li key={entry.preset.id} className="py-2">
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      disabled={entry.ship === null}
                      onClick={() => {
                        if (!entry.ship) return;
                        onSelect({
                          shipId: entry.ship.id,
                          presetId: entry.preset.id,
                          // Only ids that still resolve are handed to the
                          // calculator; a missing upgrade must not be applied as
                          // if it were a no-op modifier.
                          upgradeIds: entry.upgrades.map((u) => u.id),
                        });
                      }}
                      className="min-h-11 min-w-0 flex-1 rounded-xl px-2 py-2 text-left
                        enabled:hover:bg-slate-800/40 disabled:cursor-not-allowed disabled:opacity-60
                        focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400"
                    >
                      <span className="flex items-baseline gap-2">
                        <span className="truncate font-medium text-slate-100">
                          {entry.preset.name}
                        </span>
                        {/* Selection is spelled out, never signalled by colour alone. */}
                        {isSelected ? (
                          <span className="shrink-0 rounded-full bg-amber-400 px-2 py-0.5 text-xs font-semibold text-slate-950">
                            Selected
                          </span>
                        ) : null}
                      </span>

                      {entry.ship ? (
                        <>
                          <span className="mt-0.5 block truncate text-xs text-slate-400">
                            {entry.ship.name} · Rate <span className="tabular-nums">{entry.ship.rate}</span> ·{' '}
                            {entry.ship.shipClass} ·{' '}
                            <span className="tabular-nums">{upgradeCount}</span>{' '}
                            {upgradeCount === 1 ? 'upgrade' : 'upgrades'}
                          </span>
                          {entry.stats ? (
                            <StatsLine stats={entry.stats} verified={entry.ship.verified} />
                          ) : null}
                        </>
                      ) : (
                        <span className="mt-0.5 block text-xs text-amber-200/90">
                          ⚠ The ship this preset was built on is no longer in the database. Edit it
                          to see what it kept, or delete it.
                        </span>
                      )}

                      {entry.missingUpgradeIds.length > 0 ? (
                        <span className="mt-1 block text-xs text-amber-200/90">
                          ⚠ <span className="tabular-nums">{entry.missingUpgradeIds.length}</span>{' '}
                          saved{' '}
                          {entry.missingUpgradeIds.length === 1 ? 'upgrade is' : 'upgrades are'} no
                          longer in the database and {entry.missingUpgradeIds.length === 1 ? 'is' : 'are'}{' '}
                          not counted above.
                        </span>
                      ) : null}
                    </button>

                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="ghost"
                        onClick={() => (isEditing ? setDraft(null) : startEditing(entry))}
                        ariaLabel={`Edit ${entry.preset.name}`}
                      >
                        {isEditing ? 'Close' : 'Edit'}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => setPendingDeleteId(entry.preset.id)}
                        ariaLabel={`Delete ${entry.preset.name}`}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>

                  {/* Confirmation is inline rather than window.confirm: a native
                      dialog on a phone is easy to dismiss by accident and cannot
                      be styled or read by the rest of the screen. */}
                  {pendingDeleteId === entry.preset.id ? (
                    <div
                      role="alertdialog"
                      aria-label={`Delete ${entry.preset.name}?`}
                      className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2"
                    >
                      <span className="text-sm text-red-100">Delete “{entry.preset.name}”?</span>
                      <span className="flex gap-2">
                        <Button variant="danger" onClick={() => deletePreset(entry)}>
                          Delete
                        </Button>
                        <Button variant="ghost" onClick={() => setPendingDeleteId(null)}>
                          Cancel
                        </Button>
                      </span>
                    </div>
                  ) : null}

                  {isEditing && draft ? (
                    <div className="mt-2 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                      <label className="block">
                        <span className="text-xs tracking-wide text-slate-400 uppercase">
                          Preset name
                        </span>
                        <input
                          type="text"
                          value={draft.name}
                          onChange={(event) =>
                            setDraft((current) =>
                              current ? { ...current, name: event.target.value } : current,
                            )
                          }
                          className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950/60 px-4 py-3
                            text-base text-slate-100 placeholder:text-slate-500 focus:border-amber-400
                            focus:outline-none"
                        />
                      </label>

                      <p className="mt-3 text-xs text-slate-500">
                        Tick the upgrades fitted to this ship. None is fine.
                      </p>

                      {upgradeGroups.length === 0 ? (
                        <p className="mt-2 text-sm text-slate-400">
                          No upgrades in the database yet.
                        </p>
                      ) : (
                        upgradeGroups.map(([category, rows]) => (
                          <fieldset key={category} className="mt-3">
                            <legend className="text-xs tracking-wide text-slate-400 uppercase">
                              {category}
                            </legend>
                            <div className="mt-1 grid gap-1 sm:grid-cols-2">
                              {rows.map((upgrade) => {
                                const inputId = `${draft.presetId}-${upgrade.id}`;
                                return (
                                  <label
                                    key={upgrade.id}
                                    htmlFor={inputId}
                                    className="flex min-h-11 items-center gap-3 rounded-lg px-2 text-sm
                                      text-slate-200 hover:bg-slate-800/40"
                                  >
                                    <input
                                      id={inputId}
                                      type="checkbox"
                                      checked={draft.upgradeIds.includes(upgrade.id)}
                                      onChange={(event) =>
                                        toggleDraftUpgrade(upgrade.id, event.target.checked)
                                      }
                                      className="size-5 shrink-0 accent-amber-400"
                                    />
                                    <span className="min-w-0 truncate">{upgrade.name}</span>
                                  </label>
                                );
                              })}
                            </div>
                          </fieldset>
                        ))
                      )}

                      <div className="mt-3 flex gap-2">
                        <Button variant="primary" onClick={() => saveDraft(entry)}>
                          Save changes
                        </Button>
                        <Button variant="ghost" onClick={() => setDraft(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel>
        <h2 className="text-lg font-semibold text-slate-100">All ships</h2>

        <label className="mt-3 block">
          <span className="sr-only">Search ships by name or class</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${ships.length} ships by name or class`}
            autoComplete="off"
            className="w-full rounded-xl border border-slate-700 bg-slate-950/60 px-4 py-3 text-base
              text-slate-100 placeholder:text-slate-500 focus:border-amber-400 focus:outline-none"
          />
        </label>

        <p className="mt-2 text-xs text-slate-500" aria-live="polite">
          <span className="tabular-nums">{matches.length}</span> of{' '}
          <span className="tabular-nums">{ships.length}</span> ships
        </p>

        {matches.length === 0 ? (
          <p className="py-8 text-center text-slate-400">
            No ship matches “{query}”. Check the spelling, or search by class instead.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-800/80">
            {matches.map((ship, index) => {
              const previous = index === 0 ? null : matches[index - 1];
              const startsRate = previous === undefined || previous === null || previous.rate !== ship.rate;
              // A base ship is "selected" only when no preset is driving the
              // choice; otherwise the preset row already shows the selection.
              const isSelected = selectedPresetId === null && selectedShipId === ship.id;
              const stats = effectiveShipStats(ship);
              const isNaming = namingShipId === ship.id;
              return (
                <li key={ship.id}>
                  {startsRate ? (
                    <h3 className="mt-3 mb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                      Rate <span className="tabular-nums">{ship.rate}</span>
                    </h3>
                  ) : null}

                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => onSelect({ shipId: ship.id, presetId: null, upgradeIds: [] })}
                      className="min-h-11 min-w-0 flex-1 rounded-xl px-2 py-2 text-left hover:bg-slate-800/40
                        focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400"
                    >
                      <span className="flex items-baseline gap-2">
                        <span className="truncate font-medium text-slate-100">{ship.name}</span>
                        {isSelected ? (
                          <span className="shrink-0 rounded-full bg-amber-400 px-2 py-0.5 text-xs font-semibold text-slate-950">
                            Selected
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-slate-400">
                        Rate <span className="tabular-nums">{ship.rate}</span> · {ship.shipClass}
                        {ship.hullType ? ` · ${ship.hullType}` : ''}
                      </span>
                      <StatsLine stats={stats} verified={ship.verified} />
                    </button>

                    <Button
                      variant="ghost"
                      onClick={() => {
                        setNamingShipId(ship.id);
                        // Default to the ship's own name: most people keep it,
                        // and it means saving a preset can be two taps.
                        setNewName(ship.name);
                      }}
                      ariaLabel={`Save ${ship.name} as a preset`}
                      className="shrink-0"
                    >
                      Save as preset
                    </Button>
                  </div>

                  {isNaming ? (
                    <div className="mt-1 mb-2 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                      <label className="block" htmlFor={`new-preset-${ship.id}`}>
                        <span className="text-xs tracking-wide text-slate-400 uppercase">
                          Name this preset
                        </span>
                      </label>
                      <input
                        id={`new-preset-${ship.id}`}
                        type="text"
                        value={newName}
                        onChange={(event) => setNewName(event.target.value)}
                        className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950/60 px-4 py-3
                          text-base text-slate-100 focus:border-amber-400 focus:outline-none"
                      />
                      <p className="mt-2 text-xs text-slate-500">
                        Add upgrades afterwards with <strong>Edit</strong> — a preset with none is
                        still a complete preset.
                      </p>
                      <div className="mt-3 flex gap-2">
                        <Button variant="primary" onClick={() => createPreset(ship)}>
                          Save preset
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setNamingShipId(null);
                            setNewName('');
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
