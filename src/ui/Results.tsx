import { useMemo, useState, type JSX, type ReactNode } from 'react';
import type { RouteResult, RouteSuccess, TripPlan } from '../domain/calculator';
import { formatTenths } from '../domain/money';
import type { DestinationSuggestion } from '../domain/suggest';
import type { CurrentPrice, Good, PortState, Tenths } from '../domain/types';
import { FreshnessBadge, FreshnessDot } from './FreshnessBadge';
import { freshnessFor } from './freshness';
import { Button, Caveat, ErrorNote, Panel, Stat } from './Ui';
import { SORT_OPTIONS, buildRouteRows, sortRouteRows, type RouteRow, type SortKey } from './table';

/**
 * The results screen (SPEC 6.4 and 6.6).
 *
 * Order is the whole point: the answer first — what to buy, how many, how much
 * gold — then the four ranking metrics, then the evidence table underneath.
 * The table exists so the recommendation can be argued with; it is never the
 * first thing a phone user has to read.
 *
 * Every money value goes through formatTenths. Prices are integer tenths of
 * gold everywhere in the app (CLAUDE.md rule 3), and this file is the only
 * place they turn into "4.2".
 */

/** A ratio, not money — printed plainly so it can never be read as a price. */
function formatRatio(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(0)}%`;
}

/** Distance is an abstract map unit. Converting it to minutes would invent precision. */
function formatDistance(units: number): string {
  return `${units.toFixed(0)} units`;
}

/**
 * null stock means the Market screen showed no quantity, which is normal for
 * trade goods. Printing 0 would read as "sold out" and be a lie (SPEC 5.5).
 */
function formatStock(stock: number | null): string {
  return stock === null ? 'not shown' : String(stock);
}

function formatMoney(value: Tenths | null): string {
  return value === null ? '—' : formatTenths(value);
}

/** ISO-8601 UTC strings compare correctly as strings, so the oldest is the smallest. */
function oldestObservation(result: RouteSuccess, rows: readonly RouteRow[]): string | null {
  let oldest: string | null = null;
  for (const line of result.plan) {
    if (oldest === null || line.oldestObservationAt < oldest) oldest = line.oldestObservationAt;
  }
  if (oldest !== null) return oldest;
  // An empty plan still has evidence behind it: fall back to the table's rows so
  // "no profit here" can still be qualified with "…and the data is a day old".
  for (const row of rows) {
    if (row.observedAt !== null && (oldest === null || row.observedAt < oldest)) {
      oldest = row.observedAt;
    }
  }
  return oldest;
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h3 className="text-sm font-semibold tracking-wide text-slate-300 uppercase">{children}</h3>;
}

/**
 * A structurally impossible route (SPEC 6.6).
 *
 * The calculator's message already carries the real numbers — the ship's rate
 * and the port's minimum — so it is shown verbatim rather than paraphrased.
 */
function RouteFailureNote({
  message,
  onChangeRoute,
}: {
  message: string;
  onChangeRoute: () => void;
}) {
  return (
    <Panel>
      <ErrorNote title="This route will not work" detail={message} />
      <div className="mt-4">
        <Button variant="primary" onClick={onChangeRoute}>
          Change route
        </Button>
      </div>
    </Panel>
  );
}

/** Nearest ports that do pay, offered as tap targets rather than advice to go looking. */
function Suggestions({
  suggestions,
  now,
  onPickSuggestion,
}: {
  suggestions: readonly DestinationSuggestion[];
  now: number;
  onPickSuggestion: (portId: string) => void;
}) {
  return (
    <div className="mt-4">
      <SectionHeading>Nearest ports that do pay</SectionHeading>
      <ul className="mt-2 space-y-2">
        {suggestions.map((suggestion) => (
          <li key={suggestion.port.id}>
            <button
              type="button"
              onClick={() => onPickSuggestion(suggestion.port.id)}
              className="flex min-h-11 w-full flex-col gap-1 rounded-xl border border-slate-700
                bg-slate-800/60 px-4 py-3 text-left hover:bg-slate-700
                focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
                focus-visible:outline-amber-400"
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-slate-100">
                  {suggestion.port.displayName ?? suggestion.port.name}
                </span>
                <FreshnessBadge observedAt={suggestion.observedAt} now={now} />
              </span>
              <span className="text-sm tabular-nums text-slate-400">
                {formatDistance(suggestion.distanceUnits)} away ·{' '}
                {suggestion.profitableGoods} good{suggestion.profitableGoods === 1 ? '' : 's'} turn
                {suggestion.profitableGoods === 1 ? 's' : ''} a profit
                {suggestion.usesDemoPrices ? ' · demo prices' : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-slate-500">
        These ports have at least one good worth carrying. The actual profit is worked out once you
        pick one.
      </p>
    </div>
  );
}

/**
 * The out-and-back return leg, kept deliberately quiet.
 *
 * It is collapsed because it is the second half of the answer, and because
 * this is a phone screen: the outbound plan should not have to be scrolled past.
 * This is not multi-leg routing (SPEC 5.8) and does not pretend to be.
 */
function ReturnLeg({
  leg,
  originName,
  destinationName,
  originState,
}: {
  leg: RouteResult;
  originName: string;
  destinationName: string;
  originState: PortState | null;
}) {
  const summary = leg.ok ? formatTenths(leg.tripProfit) : 'not possible';
  return (
    <details className="rounded-2xl border border-slate-800 bg-slate-900/30">
      <summary
        className="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-4 py-3
          text-sm text-slate-300"
      >
        <span>
          Return leg · {destinationName} → {originName}
        </span>
        <span className="tabular-nums text-slate-400">{summary}</span>
      </summary>
      <div className="space-y-3 border-t border-slate-800 px-4 py-3 text-sm text-slate-400">
        {!leg.ok ? (
          <p>{leg.message}</p>
        ) : leg.plan.length === 0 ? (
          <p>{leg.emptyReason ?? `Nothing on this leg is worth carrying back to ${originName}.`}</p>
        ) : (
          <>
            <ul className="space-y-1">
              {leg.plan.map((line) => (
                <li key={line.goodId} className="flex justify-between gap-3 tabular-nums">
                  <span className="text-slate-300">
                    {line.quantity} × {line.goodName}
                  </span>
                  <span>{formatTenths(line.netProfit)}</span>
                </li>
              ))}
            </ul>
            <p className="tabular-nums text-slate-300">
              Return profit {formatTenths(leg.tripProfit)} gold over{' '}
              {formatDistance(leg.distanceUnits)}.
            </p>
          </>
        )}
        <p className="text-xs text-slate-500">
          {originState?.taxPercent == null
            ? `Nobody has recorded the sales tax at ${originName}, so these return figures assume none is taken.`
            : `Sales tax at ${originName}: ${originState.taxPercent}%.`}
        </p>
      </div>
    </details>
  );
}

export function Results({
  trip,
  goods,
  prices,
  originState,
  destinationState,
  originName,
  destinationName,
  suggestions,
  now,
  onPickSuggestion,
  onChangeRoute,
  onAddData,
}: {
  trip: TripPlan;
  goods: readonly Good[];
  prices: readonly CurrentPrice[];
  originState: PortState | null;
  destinationState: PortState | null;
  originName: string;
  destinationName: string;
  suggestions: readonly DestinationSuggestion[];
  now: number;
  onPickSuggestion: (portId: string) => void;
  onChangeRoute: () => void;
  onAddData: () => void;
}): JSX.Element {
  const [sortKey, setSortKey] = useState<SortKey>('totalProfit');
  const result = trip.outbound;
  // Hooks run before any early return, so a failed route cannot change the
  // hook order between renders.
  const success = result.ok ? result : null;
  const rows = useMemo(
    () => (success ? buildRouteRows(success, goods, prices, destinationState) : []),
    [success, goods, prices, destinationState],
  );
  const sortedRows = useMemo(
    () => (success ? sortRouteRows(rows, sortKey, success.distanceUnits) : []),
    [success, rows, sortKey],
  );

  if (!result.ok) {
    return <RouteFailureNote message={result.message} onChangeRoute={onChangeRoute} />;
  }

  const { metrics, unverified, budget } = result;
  const planIsEmpty = result.plan.length === 0;
  // "No data at all" and "data says don't bother" are different answers and get
  // different screens (SPEC 6.6).
  const hasNoPriceData = rows.every((row) => row.buyPrice === null && row.sellPrice === null);
  const band = freshnessFor(oldestObservation(result, rows), now);
  const dataMayBeWrong = band.level === 'stale' || band.level === 'wrong';
  const shortfall = budget ? budget.upperBoundProfit - result.tripProfit : 0;

  return (
    <div className="space-y-4">
      {/* 1. The answer, first and largest. */}
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">
              {originName} → {destinationName}
            </h2>
            <p className="mt-0.5 text-sm tabular-nums text-slate-400">
              {formatDistance(result.distanceUnits)} · hold {result.holdCapacity}
            </p>
          </div>
          <FreshnessBadge observedAt={oldestObservation(result, rows)} now={now} />
        </div>

        {hasNoPriceData ? (
          <div className="mt-4 space-y-3">
            <p className="text-slate-300">
              No prices have ever been recorded at {originName} or {destinationName}, so there is
              nothing to work out yet.
            </p>
            <Button variant="primary" onClick={onAddData}>
              Add prices for these ports
            </Button>
            <p className="text-xs text-slate-500">
              It opens at {originName}; there is a “Change port” button if you are somewhere else.
              Type only what you can see on screen — anything left blank stays as it is.
            </p>
          </div>
        ) : planIsEmpty ? (
          <div className="mt-4">
            <p className="text-slate-300">
              {result.emptyReason ?? `Nothing is worth carrying from ${originName} to ${destinationName}.`}
            </p>
            {suggestions.length > 0 ? (
              <Suggestions
                suggestions={suggestions}
                now={now}
                onPickSuggestion={onPickSuggestion}
              />
            ) : (
              <p className="mt-3 text-sm text-slate-400">
                Nothing profitable was found from {originName} with this ship — not on this route and
                not at any other port reachable from here.
              </p>
            )}
            <div className="mt-4">
              <Button onClick={onChangeRoute}>Change route</Button>
            </div>
          </div>
        ) : (
          <div className="mt-4">
            <p className="text-xs tracking-wide text-slate-400 uppercase">Trip profit</p>
            <p className="text-4xl font-bold tabular-nums text-amber-300">
              {formatTenths(result.tripProfit)}
            </p>
            <p className="mt-0.5 text-sm text-slate-400">
              gold, after selling everything at {destinationName}
            </p>

            <ul className="mt-4 divide-y divide-slate-800">
              {result.plan.map((line) => (
                <li key={line.goodId} className="flex items-baseline justify-between gap-3 py-2">
                  <span className="text-slate-100">
                    <span className="font-semibold tabular-nums">{line.quantity}</span> ×{' '}
                    {line.goodName}
                  </span>
                  <span className="text-right text-sm tabular-nums text-slate-400">
                    <span className="block text-slate-200">+{formatTenths(line.netProfit)}</span>
                    <span className="block">costs {formatTenths(line.purchaseCost)}</span>
                  </span>
                </li>
              ))}
            </ul>

            <p className="mt-3 text-sm tabular-nums text-slate-400">
              Spend {formatTenths(result.totalPurchaseCost)} · carry {result.totalWeightCarried} of{' '}
              {result.holdCapacity} hold · tax {formatTenths(result.totalTax)}
              {result.dockingFee > 0 ? ` · docking ${formatTenths(result.dockingFee)}` : ''}
            </p>
          </div>
        )}
      </Panel>

      {/* 2. The four ranking metrics (SPEC 5.6). Only the first is money. */}
      {!planIsEmpty && (
        <Panel>
          <dl className="grid grid-cols-2 gap-2">
            <Stat
              label="Total profit"
              value={formatTenths(metrics.totalProfit)}
              hint="Gold for the whole trip."
              emphasis
            />
            <Stat
              label="Per weight"
              value={formatRatio(metrics.profitPerWeight)}
              hint="Ranking score for a full hold. Higher is better; not a price."
            />
            <Stat
              label="Per distance"
              value={formatRatio(metrics.profitPerDistance)}
              hint={`Ranking score over ${formatDistance(result.distanceUnits)} of map. Distance is abstract, never a travel time.`}
            />
            <Stat
              label="Return on gold"
              value={formatPercent(metrics.roi)}
              hint="Profit as a share of what you spend."
            />
          </dl>
        </Panel>
      )}

      {/* 6 and 7: honesty about the inputs, before the evidence table. */}
      {(unverified.taxUnknown ||
        unverified.dockingFeeUnverified ||
        unverified.usesDemoPrices ||
        unverified.shipUnverified ||
        dataMayBeWrong ||
        budget !== null ||
        result.notes.length > 0) && (
        <Panel>
          <SectionHeading>Worth knowing</SectionHeading>
          <div className="mt-3 space-y-2">
            {dataMayBeWrong && (
              <Caveat>
                The prices behind this answer were last seen {band.ageText}. The route may be fine —
                the numbers are what may be out of date.
              </Caveat>
            )}
            {unverified.taxUnknown && (
              <Caveat>
                Nobody has recorded the sales tax at {destinationName}, so this assumes none is
                taken. If that port does charge tax, your real profit will be lower than shown.
              </Caveat>
            )}
            {unverified.dockingFeeUnverified && (
              <Caveat>
                Docking fees have never been confirmed in game, so none is included here. If you are
                charged one on arrival, subtract it from the profit above.
              </Caveat>
            )}
            {unverified.usesDemoPrices && (
              <Caveat>
                Some prices used here are example data that came with the app, not prices anyone has
                seen in game. Treat this trip as a demonstration until real prices are recorded.
              </Caveat>
            )}
            {unverified.shipUnverified && (
              <Caveat>
                This ship&rsquo;s stats have not been checked against an in-game ship card, so the
                hold size used to fill the cargo may be wrong.
              </Caveat>
            )}
            {budget !== null && budget.binding && (
              <Caveat>
                Your gold limit of {formatTenths(budget.availableGold)} changed this plan — with more
                gold to spend, a different and more profitable cargo would have been chosen.
              </Caveat>
            )}
            {budget !== null && !budget.provablyOptimal && (
              <Caveat>
                This is the best plan found, but it is not proven to be the best possible. At most{' '}
                {formatTenths(shortfall)} more gold could be on the table — the true ceiling is{' '}
                {formatTenths(budget.upperBoundProfit)}.
              </Caveat>
            )}
            {result.notes.map((note) => (
              <p key={note} className="text-sm text-slate-400">
                {note}
              </p>
            ))}
          </div>
        </Panel>
      )}

      {/* 3 and 4: how to rank the evidence, then the evidence. */}
      {!hasNoPriceData && (
        <Panel>
          <SectionHeading>Every good on this route</SectionHeading>
          <p className="mt-1 text-sm text-slate-400">
            Including the ones left behind, and why.
          </p>

          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Sort the table by">
            {SORT_OPTIONS.map((option) => {
              const active = option.key === sortKey;
              return (
                <Button
                  key={option.key}
                  onClick={() => setSortKey(option.key)}
                  variant={active ? 'primary' : 'secondary'}
                  title={option.hint}
                  // aria-pressed carries the state for screen readers, and the
                  // check mark carries it for anyone who cannot see the colour.
                  className={active ? 'ring-2 ring-amber-300' : ''}
                >
                  <span aria-hidden="true">{active ? '✓ ' : ''}</span>
                  {option.label}
                </Button>
              );
            })}
          </div>
          <p className="sr-only" aria-live="polite">
            Sorted by {SORT_OPTIONS.find((option) => option.key === sortKey)?.label}.
          </p>

          {/* The table scrolls inside this box so the page itself never slides
              sideways under a thumb. */}
          <div className="mt-3 -mx-4 overflow-x-auto sm:mx-0">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <caption className="sr-only">
                Every good on the route from {originName} to {destinationName}, with buy and sell
                prices, margin, weight, stock, how old the data is, and why each good was or was not
                chosen.
              </caption>
              <thead>
                <tr className="text-left text-xs tracking-wide text-slate-400 uppercase">
                  <th scope="col" className="px-3 py-2 font-medium">Good</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Units</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Buy</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Sell</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Margin</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">After tax</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Weight</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Stock</th>
                  <th scope="col" className="px-3 py-2 font-medium">Data</th>
                  <th scope="col" className="px-3 py-2 font-medium">Why not</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {sortedRows.map((row) => (
                  <tr
                    key={row.goodId}
                    className={row.inPlan ? 'bg-amber-400/5 text-slate-100' : 'text-slate-400'}
                  >
                    <th scope="row" className="px-3 py-2 text-left font-medium whitespace-nowrap">
                      {row.goodName}
                    </th>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {row.quantity > 0 ? row.quantity : '—'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(row.buyPrice)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(row.sellPrice)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(row.unitMargin)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMoney(row.netUnitProfit)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.weight}</td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                      {formatStock(row.stock)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <FreshnessDot observedAt={row.observedAt} now={now} />
                      {row.usesDemoPrice ? (
                        <span className="ml-2 text-xs text-slate-500">demo</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-slate-400">{row.excludedMessage ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            “Stock: not shown” means the Market screen displays no quantity for that good, which is
            normal. It does not mean the port has none.
          </p>
        </Panel>
      )}

      {/* 5. The return leg, quieter than everything above it. */}
      <ReturnLeg
        leg={trip.returnLeg}
        originName={originName}
        destinationName={destinationName}
        originState={originState}
      />

      <div>
        <Button onClick={onChangeRoute}>Change route</Button>
      </div>
    </div>
  );
}
