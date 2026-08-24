import type { Port, PortState } from '../domain/types';
import type { PortPickerView } from '../lib/prefs';
import { PortList } from './PortList';
import { PortMap } from './PortMap';
import type { FreshnessThresholds } from './freshness';

/**
 * Choosing a port, either way round.
 *
 * SPEC 6.2 calls the list an *equal* alternative to the map rather than a
 * fallback, so both are one tap apart and the choice is remembered. The list is
 * the default on a phone: when you know the port's name, typing three letters
 * beats pinching a map of 42 markers.
 */
export function PortPicker({
  ports,
  portStates,
  observations,
  shipRate,
  otherPortId,
  onPick,
  now,
  thresholds,
  view,
  onViewChange,
  stepLabel,
}: {
  ports: readonly Port[];
  portStates: ReadonlyMap<string, PortState>;
  observations: ReadonlyMap<string, string>;
  shipRate: number | null;
  otherPortId: string | null;
  onPick: (port: Port) => void;
  now: number;
  thresholds?: FreshnessThresholds;
  view: PortPickerView;
  onViewChange: (view: PortPickerView) => void;
  stepLabel: string;
}) {
  return (
    <div>
      <div
        role="tablist"
        aria-label="Choose a port by list or by map"
        className="mb-4 inline-flex rounded-xl border border-slate-700 bg-slate-900 p-1"
      >
        {(['list', 'map'] as const).map((option) => {
          const active = view === option;
          return (
            <button
              key={option}
              role="tab"
              type="button"
              aria-selected={active}
              onClick={() => onViewChange(option)}
              className={`min-h-11 rounded-lg px-4 text-sm font-medium transition-colors ${
                active
                  ? 'bg-amber-400 text-slate-950'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-slate-100'
              }`}
            >
              {option === 'list' ? 'List' : 'Map'}
              {/* The selected tab must not be signalled by colour alone. */}
              {active ? <span className="sr-only"> (selected)</span> : null}
            </button>
          );
        })}
      </div>

      {view === 'list' ? (
        <PortList
          ports={ports}
          portStates={portStates}
          observations={observations}
          shipRate={shipRate}
          otherPortId={otherPortId}
          onPick={onPick}
          now={now}
          thresholds={thresholds}
        />
      ) : (
        <PortMap
          ports={ports}
          portStates={portStates}
          observations={observations}
          shipRate={shipRate}
          otherPortId={otherPortId}
          onPick={onPick}
          now={now}
          thresholds={thresholds}
          stepLabel={stepLabel}
        />
      )}
    </div>
  );
}
