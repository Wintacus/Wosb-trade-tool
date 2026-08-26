import { useMemo, useState } from 'react';
import type { CurrentPrice, Good, Port, PortState } from '../domain/types';
import { formatTenths } from '../domain/money';
import {
  submitObservations,
  validateRows,
  type DraftRow,
  type FieldProblem,
} from '../data/submit';
import { FreshnessBadge } from './FreshnessBadge';
import { PortPicker } from './PortPicker';
import { Button, ErrorNote, Panel } from './Ui';
import { portLabel } from './ports';
import type { FreshnessThresholds } from './freshness';

/**
 * Manual price entry (SPEC 7.1) — the guaranteed path.
 *
 * OCR is an accelerator and may never be finished; this screen must stay fully
 * usable regardless (CLAUDE.md hard rule 6). So it is built to be fast on a
 * phone, standing in a port, with the game open in another app: pick the port
 * once, then type only the numbers you can actually see.
 *
 * Two decisions worth knowing about, both about not inventing data:
 *
 * 1. **The fields start empty, never pre-filled with the recorded value.**
 *    A pre-filled sheet turns "save" into re-affirming 60 numbers nobody
 *    looked at, stamped with a fresh timestamp. That is worse than no data:
 *    it launders a stale price into a fresh-looking one. The recorded value is
 *    shown beside the field as reference instead.
 *
 * 2. **Blank means unknown and is not saved.** Only the fields someone typed
 *    into become observations. A zero typed deliberately IS saved, because
 *    "the port has none left" is real information.
 */

type Section = 'trade' | 'craft';

export function PriceEntry({
  serverId,
  ports,
  portStates,
  observations,
  goods,
  prices,
  now,
  thresholds,
  initialPortId,
  drafts,
  onDraftsChange,
  onClose,
  onSaved,
}: {
  serverId: string;
  ports: readonly Port[];
  portStates: ReadonlyMap<string, PortState>;
  observations: ReadonlyMap<string, string>;
  goods: readonly Good[];
  prices: readonly CurrentPrice[];
  now: number;
  thresholds?: FreshnessThresholds;
  initialPortId: string | null;
  /**
   * Prices typed but not yet saved, held by App so they survive a reload.
   * iOS discards backgrounded tabs, and this screen's whole purpose is being
   * used while switching to the game and back -- see src/lib/session.ts.
   */
  drafts: Record<string, DraftRow>;
  onDraftsChange: (next: Record<string, DraftRow>) => void;
  onClose: () => void;
  /** Called after a successful save so the rest of the app can refetch. */
  onSaved: (count: number) => void;
}) {
  const [portId, setPortId] = useState<string | null>(initialPortId);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Record<Section, boolean>>({ trade: true, craft: false });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [problems, setProblems] = useState<FieldProblem[]>([]);
  const [warnings, setWarnings] = useState<FieldProblem[]>([]);

  const port = ports.find((p) => p.id === portId) ?? null;

  /** What is on record at this port right now, for the reference column. */
  const recorded = useMemo(() => {
    const map = new Map<string, CurrentPrice>();
    if (!portId) return map;
    for (const price of prices) {
      if (price.portId === portId) map.set(price.goodId, price);
    }
    return map;
  }, [prices, portId]);

  const matches = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return goods;
    return goods.filter((good) => good.name.toLowerCase().includes(text));
  }, [goods, query]);

  const tradeGoods = matches.filter((good) => good.isTradeGood);
  const craftGoods = matches.filter((good) => !good.isTradeGood);

  const drafted = useMemo(
    () => Object.values(drafts).filter((row) => row.buyText || row.sellText || row.stockText),
    [drafts],
  );

  const problemFor = (goodId: string, field: FieldProblem['field']) =>
    problems.find((p) => p.goodId === goodId && p.field === field)?.message ?? null;

  function edit(goodId: string, field: 'buyText' | 'sellText' | 'stockText', value: string) {
    setSavedCount(null);
    const row = drafts[goodId] ?? { goodId, buyText: '', sellText: '', stockText: '' };
    onDraftsChange({ ...drafts, [goodId]: { ...row, [field]: value } });
  }

  async function save() {
    if (!portId) return;
    setSaveError(null);
    setSavedCount(null);

    const result = validateRows(drafted, goods);
    setProblems(result.errors);
    setWarnings(result.warnings);
    if (result.errors.length > 0) return;
    if (result.rows.length === 0) return;

    setSaving(true);
    try {
      const count = await submitObservations({ serverId, portId, rows: result.rows });
      onDraftsChange({});
      setSavedCount(count);
      onSaved(count);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  if (!port) {
    return (
      <Panel>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Which port are you at?</h2>
            <p className="mt-1 text-sm text-slate-400">
              Prices belong to one port on one server. Pick the port you can see in game.
            </p>
          </div>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
        <PortPicker
          ports={ports}
          portStates={portStates}
          observations={observations}
          shipRate={null}
          otherPortId={null}
          onPick={(picked) => setPortId(picked.id)}
          now={now}
          thresholds={thresholds}
          stepLabel="Choosing where you are"
        />
      </Panel>
    );
  }

  return (
    <Panel className="pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">
            Prices at {portLabel(port)}
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Type only what you can see on screen. Anything left blank stays as it is.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setPortId(null)}>Change port</Button>
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>

      <label className="mt-4 block">
        <span className="sr-only">Search goods</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search 61 goods and resources…"
          className="w-full rounded-xl border border-slate-700 bg-slate-950/60 px-4 py-3 text-base
            text-slate-100 placeholder:text-slate-500 focus:border-amber-400 focus:outline-none"
        />
      </label>

      {savedCount !== null ? (
        <p
          role="status"
          className="mt-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100"
        >
          <span aria-hidden="true">✓</span> Saved {savedCount}{' '}
          {savedCount === 1 ? 'observation' : 'observations'}. Everyone on this server sees
          them now.
        </p>
      ) : null}

      {saveError ? (
        <div className="mt-4">
          <ErrorNote title="Nothing was saved" detail={saveError} />
        </div>
      ) : null}

      {problems.length > 0 ? (
        <p
          role="alert"
          className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-100"
        >
          {problems.length === 1 ? 'One entry' : `${problems.length} entries`} could not be
          read. They are marked below — nothing was saved.
        </p>
      ) : null}

      <div className="mt-5 flex flex-col gap-5 pb-32">
        <GoodSection
          title="Trade goods"
          subtitle="The Market tab shows one price per good, and it is what the port pays you."
          goods={tradeGoods}
          expanded={open.trade || query.trim() !== '' || craftGoods.length === 0}
          onToggle={() => setOpen((s) => ({ ...s, trade: !s.trade }))}
          drafts={drafts}
          recorded={recorded}
          now={now}
          thresholds={thresholds}
          onEdit={edit}
          problemFor={problemFor}
        />
        <GoodSection
          title="Craft resources"
          subtitle="The “Trade with port” tab: a buy price, a sell price and a quantity."
          goods={craftGoods}
          // Collapsed by default only because the trade goods above it are the
          // shorter, more commonly entered list. With nothing above it, a
          // collapsed section is just a screen with nothing on it.
          expanded={open.craft || query.trim() !== '' || tradeGoods.length === 0}
          onToggle={() => setOpen((s) => ({ ...s, craft: !s.craft }))}
          drafts={drafts}
          recorded={recorded}
          now={now}
          thresholds={thresholds}
          onEdit={edit}
          problemFor={problemFor}
        />

        {matches.length === 0 ? (
          <p className="text-sm text-slate-400">
            Nothing matches “{query}”. Check the spelling, or clear the search to see all 61.
          </p>
        ) : null}

        {warnings.length > 0 ? (
          <div className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
            <p className="font-medium">
              <span aria-hidden="true">⚠</span> Unusual, but saved as entered:
            </p>
            <ul className="mt-1 list-disc pl-5">
              {warnings.map((warning) => (
                <li key={`${warning.goodId}-${warning.field}`}>{warning.message}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <SaveBar
        count={drafted.length}
        saving={saving}
        onSave={save}
        onDiscard={() => {
          onDraftsChange({});
          setProblems([]);
          setWarnings([]);
        }}
      />
    </Panel>
  );
}

function GoodSection({
  title,
  subtitle,
  goods,
  expanded,
  onToggle,
  drafts,
  recorded,
  now,
  thresholds,
  onEdit,
  problemFor,
}: {
  title: string;
  subtitle: string;
  goods: readonly Good[];
  expanded: boolean;
  onToggle: () => void;
  drafts: Record<string, DraftRow>;
  recorded: ReadonlyMap<string, CurrentPrice>;
  now: number;
  thresholds?: FreshnessThresholds;
  onEdit: (goodId: string, field: 'buyText' | 'sellText' | 'stockText', value: string) => void;
  problemFor: (goodId: string, field: FieldProblem['field']) => string | null;
}) {
  if (goods.length === 0) return null;

  return (
    <section>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border
          border-slate-800 bg-slate-950/40 px-4 text-left hover:bg-slate-900"
      >
        <span>
          <span className="font-semibold text-slate-100">{title}</span>
          <span className="ml-2 text-xs text-slate-500">{goods.length}</span>
          <span className="block text-xs text-slate-500">{subtitle}</span>
        </span>
        <span aria-hidden="true" className="text-slate-500">
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded ? (
        <ul className="mt-2 flex flex-col gap-2">
          {goods.map((good) => (
            <GoodRow
              key={good.id}
              good={good}
              draft={drafts[good.id]}
              current={recorded.get(good.id) ?? null}
              now={now}
              thresholds={thresholds}
              onEdit={onEdit}
              problemFor={problemFor}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function GoodRow({
  good,
  draft,
  current,
  now,
  thresholds,
  onEdit,
  problemFor,
}: {
  good: Good;
  draft: DraftRow | undefined;
  current: CurrentPrice | null;
  now: number;
  thresholds?: FreshnessThresholds;
  onEdit: (goodId: string, field: 'buyText' | 'sellText' | 'stockText', value: string) => void;
  problemFor: (goodId: string, field: FieldProblem['field']) => string | null;
}) {
  const touched = Boolean(draft && (draft.buyText || draft.sellText || draft.stockText));

  /**
   * A trade good has no buy price on the Market tab -- confirmed in game on
   * 2026-08-26: it shows one number per good, and that number is what the port
   * pays you. So the field is not offered by default. Leaving an empty "Buy"
   * box next to a sell price is an invitation to type the same number into
   * both, which manufactures profit out of nothing (CLAUDE.md hard rule 1).
   *
   * It is still reachable, because "never seen" is not "cannot exist": if a
   * buy price for a trade good turns up somewhere else in the game, it can be
   * recorded without waiting for a deploy.
   */
  const [buyShown, setBuyShown] = useState(!good.isTradeGood);
  const showBuy = buyShown || Boolean(draft?.buyText);

  return (
    <li
      className={`rounded-xl border p-3 ${
        touched ? 'border-amber-400/50 bg-amber-400/5' : 'border-slate-800 bg-slate-950/40'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-slate-100">{good.name}</span>
        {current ? (
          <FreshnessBadge observedAt={current.observedAt} now={now} thresholds={thresholds} />
        ) : (
          <span className="text-xs text-slate-500">Never recorded here</span>
        )}
      </div>

      <p className="mt-1 text-xs text-slate-500">
        On record: {reference(current)}
        {current?.isDemo ? ' · placeholder data, not a real sighting' : ''}
      </p>

      <div className={`mt-2 grid gap-2 ${showBuy ? 'grid-cols-3' : 'grid-cols-2'}`}>
        {showBuy ? (
          <Field
            label="Buy"
            hint="you pay"
            value={draft?.buyText ?? ''}
            onChange={(value) => onEdit(good.id, 'buyText', value)}
            error={problemFor(good.id, 'buy')}
            decimal
          />
        ) : null}
        <Field
          label="Sell"
          hint="you get"
          value={draft?.sellText ?? ''}
          onChange={(value) => onEdit(good.id, 'sellText', value)}
          error={problemFor(good.id, 'sell')}
          decimal
        />
        <Field
          label="Stock"
          hint="if shown"
          value={draft?.stockText ?? ''}
          onChange={(value) => onEdit(good.id, 'stockText', value)}
          error={problemFor(good.id, 'stock')}
        />
      </div>

      {showBuy ? null : (
        <button
          type="button"
          onClick={() => setBuyShown(true)}
          className="mt-2 min-h-11 text-xs text-slate-500 underline underline-offset-2 hover:text-slate-300"
        >
          The game shows a buy price for {good.name}? Add one.
        </button>
      )}
    </li>
  );
}

/**
 * What is on record, in words.
 *
 * Unknown renders as an em dash, never as 0. The difference between "no
 * quantity is shown for this good" and "the port has none" is the difference
 * between a working cargo plan and an empty one (SPEC 5.5).
 */
function reference(current: CurrentPrice | null): string {
  if (!current) return 'nothing yet';
  const parts = [
    `buy ${current.buyPrice === null ? '—' : formatTenths(current.buyPrice)}`,
    `sell ${current.sellPrice === null ? '—' : formatTenths(current.sellPrice)}`,
    `stock ${current.stock === null ? 'not shown' : current.stock}`,
  ];
  return parts.join(' · ');
}

function Field({
  label,
  hint,
  value,
  onChange,
  error,
  decimal = false,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  decimal?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-400">
        {label} <span className="font-normal text-slate-600">{hint}</span>
      </span>
      <input
        // A numeric keypad on a phone, without type="number"'s scroll-wheel and
        // spinner behaviour, and without it silently discarding a bad value:
        // the text is validated where a readable reason can be shown.
        type="text"
        inputMode={decimal ? 'decimal' : 'numeric'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="—"
        aria-invalid={error ? true : undefined}
        className={`mt-1 min-h-11 w-full rounded-lg border bg-slate-950/60 px-3 text-base
          tabular-nums text-slate-100 placeholder:text-slate-600 focus:outline-none ${
            error ? 'border-red-500/70 focus:border-red-400' : 'border-slate-700 focus:border-amber-400'
          }`}
      />
      {error ? <span className="mt-1 block text-xs text-red-300">{error}</span> : null}
    </label>
  );
}

/**
 * The save bar stays on screen. On a phone the list is 61 rows long, and a
 * button at the bottom of it is a button nobody finds.
 */
function SaveBar({
  count,
  saving,
  onSave,
  onDiscard,
}: {
  count: number;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      className="sticky bottom-0 -mx-4 mt-4 border-t border-slate-800 bg-slate-900/95 px-4 py-3
        backdrop-blur sm:-mx-5 sm:px-5"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-400">
          {count === 0
            ? 'Nothing entered yet'
            : `${count} ${count === 1 ? 'good' : 'goods'} edited`}
        </p>
        <div className="flex gap-2">
          {count > 0 ? (
            <Button variant="ghost" onClick={onDiscard} disabled={saving}>
              Clear
            </Button>
          ) : null}
          <Button variant="primary" onClick={onSave} disabled={count === 0 || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}
