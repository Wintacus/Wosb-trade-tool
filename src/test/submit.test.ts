import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parseGold, parseStock, validateRows, type DraftRow } from '../data/submit';
import { parseCredentials } from '../lib/identity';
import { makeGood } from './fixtures';
import { createTestDb, type TestDb } from './pg';

/**
 * Manual price entry: what gets parsed, what gets refused, and what the
 * database actually accepts.
 *
 * The last part matters most. A mocked insert answers 200 to a request the
 * real database would refuse, and that exact blind spot once let 202 tests
 * pass over a missing table grant. So the insert this app makes is run
 * against the real schema, as a real logged-in user, with row-level security
 * switched on.
 */

const GOODS = [
  makeGood('sugar', 10, { name: 'Sugar', minPrice: 300, maxPrice: 450 }),
  makeGood('copper', 10, { name: 'Copper', minPrice: 150, maxPrice: 260 }),
  makeGood('nobands', 5, { name: 'No Bands', minPrice: null, maxPrice: null }),
];

function draft(goodId: string, buy = '', sell = '', stock = ''): DraftRow {
  return { goodId, buyText: buy, sellText: sell, stockText: stock };
}

describe('parsing money as the game displays it', () => {
  test('one decimal place becomes integer tenths', () => {
    expect(parseGold('18.9')).toEqual({ ok: true, value: 189 });
    expect(parseGold('40')).toEqual({ ok: true, value: 400 });
    expect(parseGold('0.1')).toEqual({ ok: true, value: 1 });
  });

  test('18.9 is exact — it is read from the digits, never multiplied as a float', () => {
    // 18.9 * 10 is 188.99999999999997 in floating point. Rounding would hide
    // that; not using a float at all is the actual rule.
    expect(parseGold('18.9')).toEqual({ ok: true, value: 189 });
    expect(parseGold('999999.9')).toEqual({ ok: true, value: 9999999 });
  });

  test('blank means unknown, and unknown is not zero', () => {
    expect(parseGold('')).toEqual({ ok: true, value: null });
    expect(parseGold('   ')).toEqual({ ok: true, value: null });
    expect(parseStock('')).toEqual({ ok: true, value: null });
  });

  test('two decimal places are refused with the reason', () => {
    const result = parseGold('18.95');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/one decimal place/i);
  });

  test('negative prices are refused — a negative buy price is free money', () => {
    expect(parseGold('-5').ok).toBe(false);
    expect(parseStock('-1').ok).toBe(false);
  });

  test('nonsense is refused rather than coerced', () => {
    for (const text of ['abc', '1,000', '4.2.1', '1e5', '٤']) {
      expect(parseGold(text).ok, text).toBe(false);
    }
  });

  test('stock must be a whole number', () => {
    expect(parseStock('12')).toEqual({ ok: true, value: 12 });
    expect(parseStock('12.5').ok).toBe(false);
  });
});

describe('validating a screenful of rows', () => {
  test('untouched rows produce nothing to save', () => {
    const result = validateRows([draft('sugar'), draft('copper')], GOODS);
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test('a stock of zero is a real observation and is kept', () => {
    const result = validateRows([draft('sugar', '', '', '0')], GOODS);
    expect(result.rows).toEqual([{ goodId: 'sugar', buyPrice: null, sellPrice: null, stock: 0 }]);
  });

  test('an unknown good id is rejected, not corrected', () => {
    // Unreachable from the UI. Reachable from OCR, where a crafted image can
    // make the model return any string at all (SPEC 7.2.3).
    const result = validateRows([draft('not_a_good', '', '10')], GOODS);
    expect(result.rows).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  test('one bad field does not discard the other good rows', () => {
    const result = validateRows([draft('sugar', '', 'oops'), draft('copper', '', '20')], GOODS);
    expect(result.errors).toHaveLength(1);
    expect(result.rows).toEqual([{ goodId: 'copper', buyPrice: null, sellPrice: 200, stock: null }]);
  });

  test('a price outside the recorded band warns but still saves', () => {
    const result = validateRows([draft('sugar', '', '999')], GOODS);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.message).toMatch(/higher than anything recorded/i);
  });

  test('a good with no recorded band never warns', () => {
    const result = validateRows([draft('nobands', '', '99999')], GOODS);
    expect(result.warnings).toEqual([]);
    expect(result.rows).toHaveLength(1);
  });
});

describe('stored credentials survive anything in the slot', () => {
  test('junk reads as no identity rather than throwing', () => {
    for (const raw of [null, '', 'not json', '[]', '{}', '{"email":"a"}']) {
      expect(parseCredentials(raw)).toBeNull();
    }
  });

  test('a complete pair is returned', () => {
    expect(parseCredentials('{"email":"a@b.invalid","password":"x"}')).toEqual({
      email: 'a@b.invalid',
      password: 'x',
    });
  });
});

describe('the real database accepts the row this app inserts', () => {
  let t: TestDb;
  const USER = '44444444-4444-4444-8444-444444444444';

  beforeAll(async () => {
    t = await createTestDb({ seed: true });
    await t.db.exec(`
      insert into auth.users (id, email) values ('${USER}', 'anon@anon.wosb-trade-tool.invalid');
    `);
  }, 120_000);

  afterAll(async () => {
    await t?.close();
  });

  /** Exactly the object shape src/data/submit.ts sends to PostgREST. */
  const INSERT = `
    insert into price_submissions
      (server_id, port_id, good_id, buy_price, sell_price, stock,
       submitted_by, source, is_demo, observed_at)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `;

  test('a signed-in contributor can insert once a profile exists', async () => {
    // The app creates this row itself on first save; submitted_by is a foreign
    // key to profiles, so without it the insert fails on a constraint the user
    // can do nothing about.
    await t.asUser(USER, `insert into profiles (id) values ($1)`, [USER]);

    await t.asUser(USER, INSERT, [
      'na', 'fiji', 'sugar', null, 400, null, USER, 'manual', false, new Date().toISOString(),
    ]);

    const rows = (await t.asUser(
      USER,
      `select sell_price, is_demo from prices_current
        where server_id = 'na' and port_id = 'fiji' and good_id = 'sugar'`,
    )) as { sell_price: number; is_demo: boolean }[];
    expect(rows[0]?.sell_price).toBe(400);
    // A real submission must take precedence over any demo row for that pair,
    // otherwise entering data would appear to do nothing.
    expect(rows[0]?.is_demo).toBe(false);
  });

  test('a logged-out visitor cannot insert at all', async () => {
    let refused = false;
    try {
      await t.asAnon(INSERT, [
        'na', 'fiji', 'beer', null, 70, null, null, 'manual', false, new Date().toISOString(),
      ]);
    } catch {
      refused = true;
    }
    expect(refused, 'anonymous inserts must be refused by row-level security').toBe(true);
  });

  test('a contributor cannot submit in someone else\'s name', async () => {
    let refused = false;
    try {
      await t.asUser(USER, INSERT, [
        'na', 'fiji', 'salt', null, 240, null,
        '55555555-5555-4555-8555-555555555555', 'manual', false, new Date().toISOString(),
      ]);
    } catch {
      refused = true;
    }
    expect(refused, 'submitted_by must be forced to the caller').toBe(true);
  });

  test('a contributor cannot pass their entry off as demo data', async () => {
    for (const [source, isDemo] of [['demo', false], ['manual', true]] as const) {
      let refused = false;
      try {
        await t.asUser(USER, INSERT, [
          'na', 'fiji', 'wine', null, 120, null, USER, source, isDemo, new Date().toISOString(),
        ]);
      } catch {
        refused = true;
      }
      expect(refused, `source=${source} is_demo=${isDemo} must be refused`).toBe(true);
    }
  });

  test('the database refuses a negative price even if this app somehow sends one', async () => {
    let refused = false;
    try {
      await t.asUser(USER, INSERT, [
        'na', 'fiji', 'rugs', -1, 400, null, USER, 'manual', false, new Date().toISOString(),
      ]);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });

  test('submissions are append-only: an earlier one is never overwritten', async () => {
    const older = new Date(Date.now() - 3_600_000).toISOString();
    await t.asUser(USER, INSERT, [
      'na', 'st_john', 'silk', null, 880, null, USER, 'manual', false, older,
    ]);
    await t.asUser(USER, INSERT, [
      'na', 'st_john', 'silk', null, 900, null, USER, 'manual', false, new Date().toISOString(),
    ]);

    const all = (await t.asUser(
      USER,
      `select count(*)::int n from price_submissions
        where port_id = 'st_john' and good_id = 'silk' and not is_demo`,
    )) as { n: number }[];
    expect(all[0]?.n).toBe(2);

    const current = (await t.asUser(
      USER,
      `select sell_price from prices_current
        where server_id = 'na' and port_id = 'st_john' and good_id = 'silk'`,
    )) as { sell_price: number }[];
    expect(current[0]?.sell_price).toBe(900);
  });
});
