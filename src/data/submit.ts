import { supabase } from '../lib/supabase';
import { ensureIdentity } from '../lib/identity';
import type { Good, Tenths } from '../domain/types';

/**
 * Saving what someone saw at a port.
 *
 * Nothing is overwritten. Every observation is appended as its own row in
 * `price_submissions`, and the `prices_current` view picks the one the
 * calculator should use. That is what makes price history, disagreement
 * between contributors and Phase 4's consensus weighting possible; a single
 * mutable row per port and good would destroy all three.
 *
 * Every value is validated here BEFORE it is sent, and the database validates
 * it again with CHECK constraints. Both layers are deliberate. This one exists
 * to give a person a readable reason on the screen they are typing into; the
 * database one exists because it is the only check that cannot be bypassed,
 * and because OCR (SPEC.md 7.2) will later push values through this same path
 * from a model that must never be structurally trusted.
 */

/**
 * The largest value the database columns can hold (Postgres `integer`).
 *
 * The parsers used to accept anything up to Number.MAX_SAFE_INTEGER, so a
 * value the client called valid was rejected by the column -- and because the
 * insert is a single statement, one mistyped field threw away the whole batch
 * with a raw "out of range for type integer" in the user's face.
 */
const MAX_STORED = 2_147_483_647;

/** What a person typed into one row of the entry screen. */
export interface DraftRow {
  goodId: string;
  /** Empty string means "leave this alone", not "zero". */
  buyText: string;
  sellText: string;
  stockText: string;
}

/** A validated row, ready for the database. */
export interface ParsedRow {
  goodId: string;
  buyPrice: Tenths | null;
  sellPrice: Tenths | null;
  stock: number | null;
}

export interface FieldProblem {
  goodId: string;
  field: 'buy' | 'sell' | 'stock';
  message: string;
}

/** Not an error: the value is usable but looks unlike anything seen before. */
export interface FieldWarning extends FieldProblem {}

export interface ValidationResult {
  rows: ParsedRow[];
  errors: FieldProblem[];
  warnings: FieldWarning[];
}

/**
 * Parse a price as the game displays it into integer tenths of gold.
 *
 * Done on the string rather than by multiplying a float, because "18.9" is not
 * exactly representable and 18.9 * 10 is 188.99999999999997. Rounding would
 * hide that, but the rule is that no float ever represents currency at all
 * (CLAUDE.md hard rule 3), so the digits are read directly.
 */
export function parseGold(raw: string): { ok: true; value: Tenths | null } | { ok: false; error: string } {
  const text = raw.trim();
  if (text === '') return { ok: true, value: null };
  if (!/^\d+(\.\d)?$/.test(text)) {
    if (/^\d+\.\d{2,}$/.test(text)) {
      return { ok: false, error: 'The game shows one decimal place — 18.9, not 18.95.' };
    }
    if (text.startsWith('-')) return { ok: false, error: 'A price cannot be negative.' };
    return { ok: false, error: 'Enter a number like 18.9.' };
  }
  const [whole, tenth = '0'] = text.split('.');
  const value = Number(whole) * 10 + Number(tenth);
  if (!Number.isSafeInteger(value) || value > MAX_STORED) {
    return { ok: false, error: 'That number is too large.' };
  }
  return { ok: true, value };
}

/** Parse a stock count. Blank stays blank: unknown stock is not zero stock. */
export function parseStock(raw: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const text = raw.trim();
  if (text === '') return { ok: true, value: null };
  if (!/^\d+$/.test(text)) {
    return { ok: false, error: 'Enter a whole number, or leave it blank if the game shows none.' };
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value > MAX_STORED) {
    return { ok: false, error: 'That number is too large.' };
  }
  return { ok: true, value };
}

/**
 * Validate every edited row against the known goods and their observed bands.
 *
 * A price outside the band recorded in goods.json is a warning, never a
 * rejection. The bands come from a handful of real observations, so a value
 * outside one is more likely to be new information than a mistake — and
 * refusing a real number the user is looking at would teach them the tool is
 * wrong. Phase 4 flags these for review (SPEC.md 8); Phase 3 says so on screen
 * and saves it anyway.
 */
export function validateRows(drafts: readonly DraftRow[], goods: readonly Good[]): ValidationResult {
  const byId = new Map(goods.map((good) => [good.id, good]));
  const rows: ParsedRow[] = [];
  const errors: FieldProblem[] = [];
  const warnings: FieldWarning[] = [];

  for (const draft of drafts) {
    const good = byId.get(draft.goodId);
    if (!good) {
      // Unreachable from the UI, which builds its rows from the goods list.
      // It is reachable from OCR, where a model can return any string at all.
      errors.push({ goodId: draft.goodId, field: 'sell', message: 'Unknown good.' });
      continue;
    }

    const buy = parseGold(draft.buyText);
    const sell = parseGold(draft.sellText);
    const stock = parseStock(draft.stockText);

    if (!buy.ok) errors.push({ goodId: good.id, field: 'buy', message: buy.error });
    if (!sell.ok) errors.push({ goodId: good.id, field: 'sell', message: sell.error });
    if (!stock.ok) errors.push({ goodId: good.id, field: 'stock', message: stock.error });
    if (!buy.ok || !sell.ok || !stock.ok) continue;

    // Nothing typed in any field: there is no observation here to record.
    if (buy.value === null && sell.value === null && stock.value === null) continue;

    for (const [field, value] of [
      ['buy', buy.value],
      ['sell', sell.value],
    ] as const) {
      if (value === null) continue;
      const low = good.minPrice;
      const high = good.maxPrice;
      if (low !== null && value < low) {
        warnings.push({
          goodId: good.id,
          field,
          message: `Lower than anything recorded for ${good.name} before (${tenths(low)}). Saved anyway — check it if that looks wrong.`,
        });
      } else if (high !== null && value > high) {
        warnings.push({
          goodId: good.id,
          field,
          message: `Higher than anything recorded for ${good.name} before (${tenths(high)}). Saved anyway — check it if that looks wrong.`,
        });
      }
    }

    rows.push({
      goodId: good.id,
      buyPrice: buy.value,
      sellPrice: sell.value,
      stock: stock.value,
    });
  }

  return { rows, errors, warnings };
}

function tenths(value: Tenths): string {
  return `${Math.floor(value / 10)}.${value % 10}`;
}

export interface SubmitInput {
  serverId: string;
  portId: string;
  rows: readonly ParsedRow[];
  /** manual | ocr | screenshare. Never 'demo' — the policy rejects that. */
  source?: string;
  /** When the values were seen. Defaults to now. */
  observedAt?: string;
}

/**
 * Append the observations. Returns how many rows were written.
 *
 * The account is created here, lazily, on the first save of this browser's
 * life. Doing it any earlier would mint an account for every visitor who only
 * ever reads.
 */
export async function submitObservations(input: SubmitInput): Promise<number> {
  if (input.rows.length === 0) return 0;
  if (!supabase) {
    throw new Error(
      'The app is not connected to its database, so nothing can be saved. ' +
        'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are missing from this deployment.',
    );
  }

  // Guard the values one final time, at the point every caller meets.
  //
  // `validateRows` covers the entry screen, but submitObservations is the
  // shared door -- OCR is meant to come through it too, from a model whose
  // output must never be trusted structurally. The specific hazard: NaN and
  // Infinity survive every `typeof x === 'number'` check and then become JSON
  // `null` on the wire, producing a row that says nothing at all. Because
  // prices_current takes whole rows by timestamp, that row becomes the current
  // price and destroys a real observation. Reproduced: 220/189/40 -> nulls.
  for (const row of input.rows) {
    for (const [field, value] of [
      ['buy price', row.buyPrice],
      ['sell price', row.sellPrice],
      ['stock', row.stock],
    ] as const) {
      if (value === null) continue;
      if (!Number.isInteger(value) || value < 0 || value > MAX_STORED) {
        throw new Error(
          `Refusing to save ${row.goodId}: ${field} is not a usable whole number.`,
        );
      }
    }
    if (row.buyPrice === null && row.sellPrice === null && row.stock === null) {
      throw new Error(
        `Refusing to save ${row.goodId}: nothing was recorded for it.`,
      );
    }
  }

  const userId = await ensureIdentity();
  const observedAt = input.observedAt ?? new Date().toISOString();

  const payload = input.rows.map((row) => ({
    server_id: input.serverId,
    port_id: input.portId,
    good_id: row.goodId,
    buy_price: row.buyPrice,
    sell_price: row.sellPrice,
    stock: row.stock,
    submitted_by: userId,
    source: input.source ?? 'manual',
    is_demo: false,
    observed_at: observedAt,
  }));

  const { error } = await supabase.from('price_submissions').insert(payload);
  if (error) throw new Error(`Could not save your prices: ${error.message}`);
  return payload.length;
}
