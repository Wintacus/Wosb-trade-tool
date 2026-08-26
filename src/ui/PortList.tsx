import { useMemo, useState } from 'react';
import type { Port, PortState } from '../domain/types';
import { FreshnessDot } from './FreshnessBadge';
import type { FreshnessThresholds } from './freshness';
import { portAvailability, portLabel, searchPorts } from './ports';

/**
 * The searchable port list.
 *
 * SPEC 6.2 calls this an *equal* alternative to the map, not a fallback, and it
 * is the phone default: when you already know the port's name, typing three
 * letters beats pinching a map of 42 markers.
 */
export function PortList({
  ports,
  portStates,
  observations,
  shipRate,
  otherPortId,
  onPick,
  now,
  thresholds,
}: {
  ports: readonly Port[];
  portStates: ReadonlyMap<string, PortState>;
  observations: ReadonlyMap<string, string>;
  shipRate: number | null;
  otherPortId: string | null;
  onPick: (port: Port) => void;
  now: number;
  thresholds?: FreshnessThresholds;
}) {
  const [query, setQuery] = useState('');
  const matches = useMemo(() => searchPorts(ports, query), [ports, query]);

  return (
    <div>
      <label className="block">
        <span className="sr-only">Search ports by name</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search 42 ports by name"
          autoComplete="off"
          className="w-full rounded-xl border border-slate-700 bg-slate-950/60 px-4 py-3 text-base
            text-slate-100 placeholder:text-slate-500 focus:border-amber-400 focus:outline-none"
        />
      </label>

      <p className="mt-2 text-xs text-slate-500" aria-live="polite">
        {matches.length} of {ports.length} ports
      </p>

      {matches.length === 0 ? (
        <p className="py-8 text-center text-slate-400">
          No port matches “{query}”. Check the spelling, or switch to the map.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-800/80">
          {matches.map((port) => {
            const state = portStates.get(port.id) ?? null;
            const availability = portAvailability(port, state, shipRate, otherPortId);
            return (
              <li key={port.id}>
                <button
                  type="button"
                  disabled={!availability.selectable}
                  onClick={() => onPick(port)}
                  title={availability.message ?? undefined}
                  className="flex w-full items-center justify-between gap-3 px-1 py-3 text-left
                    enabled:hover:bg-slate-800/40 disabled:cursor-not-allowed disabled:opacity-45
                    focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-slate-100">
                      {portLabel(port)}
                    </span>
                    {availability.message ? (
                      // The reason is always visible text, never a hover-only
                      // tooltip: there is no hover on a phone.
                      <span className="mt-0.5 block text-xs text-amber-200/80">
                        {availability.message}
                      </span>
                    ) : (
                      <span className="mt-1 block">
                        <FreshnessDot
                          observedAt={observations.get(port.id) ?? null}
                          now={now}
                          thresholds={thresholds}
                        />
                      </span>
                    )}
                  </span>
                  {state?.controllingFaction ? (
                    <span className="shrink-0 rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
                      {state.controllingFaction}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
