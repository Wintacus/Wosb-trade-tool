import { useCallback, useEffect, useMemo, useState } from 'react';
import { planTrip } from './domain/calculator';
import { toTenths } from './domain/money';
import { suggestDestinations } from './domain/suggest';
import type { Port } from './domain/types';
import {
  latestObservationByPort,
  loadReference,
  loadServerData,
  type ReferenceData,
  type ServerData,
} from './data/queries';
import {
  loadPrefs,
  rememberRoute,
  savePrefs,
  type Prefs,
  type ShipPreset,
} from './lib/prefs';
import { Diagnostics } from './ui/Diagnostics';
import { PortPicker } from './ui/PortPicker';
import { PriceEntry } from './ui/PriceEntry';
import { Results } from './ui/Results';
import { ServerBadge, ServerPrompt } from './ui/ServerPicker';
import { ShipPicker } from './ui/ShipPicker';
import { Button, ErrorNote, Panel, Spinner } from './ui/Ui';
import { portLabel } from './ui/ports';

/**
 * The four-step flow (SPEC 6.1): origin, destination, ship, results.
 *
 * The steps are a piece of state rather than routes, deliberately. Everything
 * the tool computes comes from four values held here, the whole flow fits in
 * one screen's worth of state, and a phone browser's back button never lands
 * the user on a half-filled route that no longer matches what is displayed.
 */

type Step = 'origin' | 'destination' | 'ship' | 'results';

const STEPS: { id: Step; label: string }[] = [
  { id: 'origin', label: 'From' },
  { id: 'destination', label: 'To' },
  { id: 'ship', label: 'Ship' },
  { id: 'results', label: 'Result' },
];

/** Freshness ages while the screen is open, so the clock is refreshed. */
const CLOCK_INTERVAL_MS = 60_000;

interface ShipChoice {
  shipId: string;
  presetId: string | null;
  upgradeIds: string[];
}

export default function App() {
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs());
  const [reference, setReference] = useState<ReferenceData | null>(null);
  const [serverData, setServerData] = useState<ServerData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [step, setStep] = useState<Step>('origin');
  const [originId, setOriginId] = useState<string | null>(null);
  const [destinationId, setDestinationId] = useState<string | null>(null);
  const [shipChoice, setShipChoice] = useState<ShipChoice | null>(null);

  /**
   * Price entry is a mode, not a fifth step.
   *
   * It answers a different question from the four-step flow -- "here is what I
   * can see right now" rather than "what should I carry" -- and it is reachable
   * from anywhere, including before a route exists. Making it a step would put
   * it in the progress bar and imply the flow is unfinished without it.
   */
  const [entry, setEntry] = useState<{ portId: string | null } | null>(null);

  const [showDiagnostics, setShowDiagnostics] = useState(
    () => typeof location !== 'undefined' && new URLSearchParams(location.search).has('diagnostics'),
  );

  /** Persist preferences on every change; they are small and this is cheap. */
  const updatePrefs = useCallback((change: (current: Prefs) => Prefs) => {
    setPrefs((current) => {
      const next = change(current);
      savePrefs(next);
      return next;
    });
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadReference()
      .then((data) => {
        if (!cancelled) setReference(data);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const serverId = prefs.serverId;

  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;
    // Clear first: showing the previous server's prices under a new server's
    // name would be exactly the economy-mixing the schema is scoped to prevent.
    setServerData(null);
    loadServerData(serverId)
      .then((data) => {
        if (!cancelled) setServerData(data);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  /**
   * Re-read prices after a save, without blanking the screen.
   *
   * The freshly entered numbers have to show up immediately -- entering data
   * and seeing no change is indistinguishable from it not having worked. This
   * keeps the current data on screen while the new data arrives, so the entry
   * sheet does not flash empty underneath.
   */
  const refreshServerData = useCallback(() => {
    if (!serverId) return;
    loadServerData(serverId)
      .then(setServerData)
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : String(error));
      });
  }, [serverId]);

  const ports = reference?.ports ?? [];
  const portStates = serverData?.portStates ?? new Map();
  const prices = useMemo(() => serverData?.prices ?? [], [serverData]);
  const observations = useMemo(() => latestObservationByPort(prices), [prices]);

  const origin = ports.find((port) => port.id === originId) ?? null;
  const destination = ports.find((port) => port.id === destinationId) ?? null;
  const ship = reference?.ships.find((s) => s.id === shipChoice?.shipId) ?? null;
  const upgrades = useMemo(() => {
    if (!reference || !shipChoice) return [];
    const wanted = new Set(shipChoice.upgradeIds);
    return reference.upgrades.filter((upgrade) => wanted.has(upgrade.id));
  }, [reference, shipChoice]);

  const trip = useMemo(() => {
    if (!serverData || !origin || !destination || !ship || !reference) return null;
    return planTrip({
      serverId: serverData.serverId,
      origin,
      destination,
      originState: portStates.get(origin.id) ?? null,
      destinationState: portStates.get(destination.id) ?? null,
      ship,
      upgrades,
      goods: reference.goods,
      prices,
      availableGold: prefs.availableGold,
    });
  }, [serverData, origin, destination, ship, reference, portStates, upgrades, prices, prefs.availableGold]);

  /**
   * Alternatives, computed only when the route came back empty. The screen for
   * "nothing is profitable here" is the one place a user most needs a next
   * move, and the one place this tool would otherwise be a dead end.
   */
  const suggestions = useMemo(() => {
    if (!trip || !serverData || !origin || !ship || !reference) return [];
    const outbound = trip.outbound;
    if (outbound.ok && outbound.plan.length > 0) return [];
    return suggestDestinations({
      serverId: serverData.serverId,
      origin,
      originState: portStates.get(origin.id) ?? null,
      ship,
      upgrades,
      ports,
      portStates,
      goods: reference.goods,
      prices,
      availableGold: prefs.availableGold,
      exclude: destinationId ? [destinationId] : [],
    });
  }, [trip, serverData, origin, ship, reference, portStates, upgrades, ports, prices, prefs.availableGold, destinationId]);

  function chooseOrigin(port: Port) {
    setOriginId(port.id);
    setStep('destination');
  }

  function chooseDestination(port: Port) {
    setDestinationId(port.id);
    setStep('ship');
  }

  function chooseShip(choice: ShipChoice) {
    setShipChoice(choice);
    if (originId && destinationId) {
      updatePrefs((current) => ({
        ...current,
        recentRoutes: rememberRoute(current.recentRoutes, {
          originPortId: originId,
          destinationPortId: destinationId,
          shipId: choice.shipId,
          presetId: choice.presetId,
          lastUsedAt: new Date().toISOString(),
        }),
      }));
    }
    setStep('results');
  }

  function swapEnds() {
    setOriginId(destinationId);
    setDestinationId(originId);
  }

  function resetRoute() {
    setOriginId(null);
    setDestinationId(null);
    setStep('origin');
  }

  /** Jump straight to a suggested destination, keeping origin and ship. */
  function pickSuggestion(portId: string) {
    setDestinationId(portId);
    setStep('results');
  }

  if (showDiagnostics) {
    return (
      <Shell
        servers={reference?.servers ?? []}
        serverId={serverId}
        onServerChange={(id) => updatePrefs((current) => ({ ...current, serverId: id }))}
        onShowDiagnostics={() => setShowDiagnostics(true)}
      >
        <Diagnostics onBack={() => setShowDiagnostics(false)} />
      </Shell>
    );
  }

  return (
    <Shell
      servers={reference?.servers ?? []}
      serverId={serverId}
      onServerChange={(id) => updatePrefs((current) => ({ ...current, serverId: id }))}
      onShowDiagnostics={() => setShowDiagnostics(true)}
      // Defaults to the port already in view rather than asking again: opening
      // this with portId: null shows the exact same searchable port list as
      // step 1 of the main flow, and from a real phone that read as the whole
      // app having reset — a route and ship that were never actually touched,
      // reappearing to look like a fresh start. Preferring the current
      // destination when there's no origin (e.g. still on step "To") means
      // this never asks a redundant question when a port is already on screen.
      onAddPrices={
        serverId && serverData && !entry
          ? () => setEntry({ portId: origin?.id ?? destination?.id ?? null })
          : undefined
      }
    >
      {loadError ? (
        <ErrorNote
          title="Could not load the data"
          detail={`${loadError} — the database checks at the bottom of this page will say more.`}
        />
      ) : null}

      {!reference && !loadError ? <Spinner label="Loading ports, ships and goods…" /> : null}

      {reference && !serverId ? (
        <ServerPrompt
          servers={reference.servers}
          onChoose={(id) => updatePrefs((current) => ({ ...current, serverId: id }))}
        />
      ) : null}

      {reference && serverId && !serverData && !loadError ? (
        <Spinner label="Loading prices for this server…" />
      ) : null}

      {reference && serverId && serverData && entry ? (
        <PriceEntry
          serverId={serverId}
          ports={ports}
          portStates={portStates}
          observations={observations}
          goods={reference.goods}
          prices={prices}
          now={now}
          initialPortId={entry.portId}
          onClose={() => setEntry(null)}
          onSaved={refreshServerData}
        />
      ) : null}

      {reference && serverId && serverData && !entry ? (
        <>
          <StepBar
            step={step}
            originName={origin ? portLabel(origin) : null}
            destinationName={destination ? portLabel(destination) : null}
            shipName={ship?.name ?? null}
            onGoTo={setStep}
          />

          {step === 'origin' || step === 'destination' ? (
            <Panel>
              <RouteHeading
                step={step}
                origin={origin}
                destination={destination}
                onSwap={swapEnds}
                onReset={resetRoute}
              />
              <PortPicker
                ports={ports}
                portStates={portStates}
                observations={observations}
                shipRate={ship?.rate ?? null}
                otherPortId={step === 'origin' ? destinationId : originId}
                onPick={step === 'origin' ? chooseOrigin : chooseDestination}
                now={now}
                stepLabel={step === 'origin' ? 'Choosing where to buy' : 'Choosing where to sell'}
              />
              {step === 'origin' && prefs.recentRoutes.length > 0 ? (
                <RecentRoutes
                  prefs={prefs}
                  ports={ports}
                  onPick={(route) => {
                    setOriginId(route.originPortId);
                    setDestinationId(route.destinationPortId);
                    const preset = prefs.presets.find((p) => p.id === route.presetId);
                    setShipChoice({
                      shipId: route.shipId,
                      presetId: preset?.id ?? null,
                      upgradeIds: preset?.upgradeIds ?? [],
                    });
                    setStep('results');
                  }}
                />
              ) : null}
            </Panel>
          ) : null}

          {step === 'ship' ? (
            <Panel>
              <h2 className="mb-3 text-lg font-semibold text-slate-100">Which ship?</h2>
              <ShipPicker
                ships={reference.ships}
                upgrades={reference.upgrades}
                presets={prefs.presets}
                onPresetsChange={(next: ShipPreset[]) =>
                  updatePrefs((current) => ({ ...current, presets: next }))
                }
                selectedShipId={shipChoice?.shipId ?? null}
                selectedPresetId={shipChoice?.presetId ?? null}
                onSelect={chooseShip}
              />
              <GoldLimit
                availableGold={prefs.availableGold}
                onChange={(value) =>
                  updatePrefs((current) => ({ ...current, availableGold: value }))
                }
              />
            </Panel>
          ) : null}

          {step === 'results' && trip && origin && destination ? (
            <Results
              trip={trip}
              goods={reference.goods}
              prices={prices}
              originState={portStates.get(origin.id) ?? null}
              destinationState={portStates.get(destination.id) ?? null}
              originName={portLabel(origin)}
              destinationName={portLabel(destination)}
              suggestions={suggestions}
              now={now}
              onPickSuggestion={pickSuggestion}
              onChangeRoute={() => setStep('origin')}
              onAddData={() => setEntry({ portId: origin.id })}
            />
          ) : null}

          {step === 'results' && !trip ? (
            <Panel>
              <p className="text-slate-300">
                Pick an origin, a destination and a ship first.
              </p>
              <Button className="mt-3" variant="primary" onClick={resetRoute}>
                Start again
              </Button>
            </Panel>
          ) : null}
        </>
      ) : null}
    </Shell>
  );
}

function Shell({
  children,
  servers,
  serverId,
  onServerChange,
  onShowDiagnostics,
  onAddPrices,
}: {
  children: React.ReactNode;
  servers: { id: string; name: string }[];
  serverId: string | null;
  onServerChange: (id: string) => void;
  onShowDiagnostics: () => void;
  onAddPrices?: () => void;
}) {
  return (
    <div className="min-h-dvh bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-dvh max-w-4xl flex-col gap-5 px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium tracking-[0.2em] text-slate-500 uppercase">
              Unofficial fan tool
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">WOSB Trade Tool</h1>
          </div>
          <div className="flex items-center gap-2">
            {onAddPrices ? (
              <Button onClick={onAddPrices}>
                <span aria-hidden="true">＋</span> Add prices
              </Button>
            ) : null}
            {serverId && servers.length > 0 ? (
              <ServerBadge servers={servers} serverId={serverId} onChange={onServerChange} />
            ) : null}
          </div>
        </header>

        <main className="flex flex-col gap-5">{children}</main>

        <footer className="mt-auto flex flex-col gap-2 pt-6 text-xs leading-relaxed text-slate-500">
          <button
            type="button"
            onClick={onShowDiagnostics}
            className="self-start underline underline-offset-2 hover:text-slate-300"
          >
            Database checks
          </button>
          <p>
            Not affiliated with, endorsed by, or connected to the developers of World of Sea
            Battle. Game data is community-contributed and may be wrong or out of date.
          </p>
        </footer>
      </div>
    </div>
  );
}

function StepBar({
  step,
  originName,
  destinationName,
  shipName,
  onGoTo,
}: {
  step: Step;
  originName: string | null;
  destinationName: string | null;
  shipName: string | null;
  onGoTo: (step: Step) => void;
}) {
  const value: Record<Step, string | null> = {
    origin: originName,
    destination: destinationName,
    ship: shipName,
    results: null,
  };
  const reached: Record<Step, boolean> = {
    origin: true,
    destination: originName !== null,
    ship: originName !== null && destinationName !== null,
    results: originName !== null && destinationName !== null && shipName !== null,
  };

  return (
    <ol className="flex flex-wrap gap-2">
      {STEPS.map((entry, index) => {
        const active = entry.id === step;
        return (
          <li key={entry.id}>
            <button
              type="button"
              disabled={!reached[entry.id]}
              onClick={() => onGoTo(entry.id)}
              className={`flex min-h-11 items-center gap-2 rounded-xl border px-3 text-sm transition-colors
                disabled:cursor-not-allowed disabled:opacity-40 ${
                  active
                    ? 'border-amber-400 bg-amber-400/10 text-amber-200'
                    : 'border-slate-700 bg-slate-900 text-slate-300 enabled:hover:bg-slate-800'
                }`}
            >
              <span className="text-xs text-slate-500">{index + 1}</span>
              <span className="font-medium">{entry.label}</span>
              {value[entry.id] ? (
                <span className="max-w-32 truncate text-slate-400">{value[entry.id]}</span>
              ) : null}
              {/* The current step is named, not merely tinted. */}
              {active ? <span className="sr-only">(current step)</span> : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function RouteHeading({
  step,
  origin,
  destination,
  onSwap,
  onReset,
}: {
  step: Step;
  origin: Port | null;
  destination: Port | null;
  onSwap: () => void;
  onReset: () => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-100">
          {step === 'origin' ? 'Where are you buying?' : 'Where are you selling?'}
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          {origin ? `From ${portLabel(origin)}` : 'No origin chosen yet'}
          {destination ? ` → ${portLabel(destination)}` : ''}
        </p>
      </div>
      <div className="flex gap-2">
        <Button onClick={onSwap} disabled={!origin || !destination}>
          Swap ends
        </Button>
        <Button variant="ghost" onClick={onReset} disabled={!origin && !destination}>
          Reset
        </Button>
      </div>
    </div>
  );
}

function RecentRoutes({
  prefs,
  ports,
  onPick,
}: {
  prefs: Prefs;
  ports: readonly Port[];
  onPick: (route: Prefs['recentRoutes'][number]) => void;
}) {
  const name = (id: string) => {
    const port = ports.find((p) => p.id === id);
    return port ? portLabel(port) : id;
  };
  return (
    <div className="mt-6 border-t border-slate-800 pt-4">
      <h3 className="text-sm font-semibold tracking-wider text-slate-400 uppercase">
        Recent routes
      </h3>
      <p className="mt-1 text-xs text-slate-500">These skip straight to the result.</p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {prefs.recentRoutes.map((route) => (
          <li key={`${route.originPortId}-${route.destinationPortId}-${route.shipId}`}>
            <Button onClick={() => onPick(route)}>
              {name(route.originPortId)} → {name(route.destinationPortId)}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The optional gold limit (SPEC 5.7).
 *
 * Typed in gold as the game shows it, stored as integer tenths, because money
 * never touches a float anywhere in this codebase. Blank means unconstrained —
 * which is not the same as zero, and must not become it.
 */
function GoldLimit({
  availableGold,
  onChange,
}: {
  availableGold: number | null;
  onChange: (value: number | null) => void;
}) {
  const [text, setText] = useState(
    availableGold === null ? '' : (availableGold / 10).toString(),
  );

  return (
    <div className="mt-5 border-t border-slate-800 pt-4">
      <label className="block">
        <span className="text-sm font-medium text-slate-300">Gold available (optional)</span>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="0.1"
          value={text}
          onChange={(event) => {
            const raw = event.target.value;
            setText(raw);
            if (raw.trim() === '') {
              onChange(null);
              return;
            }
            const parsed = Number(raw);
            onChange(Number.isFinite(parsed) && parsed >= 0 ? toTenths(parsed) : null);
          }}
          placeholder="Leave blank for no limit"
          className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950/60 px-4 py-3
            text-base text-slate-100 placeholder:text-slate-500 focus:border-amber-400 focus:outline-none"
        />
      </label>
      <p className="mt-1 text-xs text-slate-500">
        Early on, gold runs out before hold space does. Set this and the plan will only
        recommend cargo you can actually pay for.
      </p>
    </div>
  );
}
