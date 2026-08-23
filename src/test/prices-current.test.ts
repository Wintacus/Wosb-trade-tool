import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from './pg';

/**
 * SPEC.md 5.9 test 10 -- demo-data displacement.
 *
 * This runs the real supabase/schema.sql against a real Postgres (PGlite,
 * Postgres compiled to WebAssembly), so it tests the actual view definition
 * the user pastes into Supabase rather than a TypeScript imitation of it.
 */

let t: TestDb;

const PORT = 'fiji';
const OTHER_PORT = 'st_john';
const GOOD = 'sugar';
const OTHER_GOOD = 'silk';
const SERVER = 'na';

async function rowsFor(portId: string, goodId: string) {
  return (await t.db.query(
    `select buy_price, sell_price, is_demo, source
       from prices_current
      where server_id = $1 and port_id = $2 and good_id = $3`,
    [SERVER, portId, goodId],
  )) as { rows: { buy_price: number; sell_price: number; is_demo: boolean; source: string }[] };
}

beforeAll(async () => {
  t = await createTestDb({ seed: true });
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe('10. demo-data displacement', () => {
  test('a demo row IS returned when no real submission exists', async () => {
    await t.db.exec(`
      insert into price_submissions
        (server_id, port_id, good_id, buy_price, sell_price, source, is_demo, observed_at)
      values
        ('${SERVER}', '${PORT}', '${OTHER_GOOD}', 500, 500, 'demo', true,
         now() - interval '2 hours');
    `);

    const result = await rowsFor(PORT, OTHER_GOOD);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.is_demo).toBe(true);
    expect(result.rows[0]!.buy_price).toBe(500);
  });

  test('a real submission displaces the demo row for the same port and good', async () => {
    await t.db.exec(`
      insert into price_submissions
        (server_id, port_id, good_id, buy_price, sell_price, source, is_demo, observed_at)
      values
        ('${SERVER}', '${PORT}', '${GOOD}', 111, 111, 'demo',   true,  now()),
        ('${SERVER}', '${PORT}', '${GOOD}', 222, 222, 'manual', false, now() - interval '1 day');
    `);

    const result = await rowsFor(PORT, GOOD);
    // Exactly one row, and it is the real one -- even though the demo row is
    // NEWER. Recency must not let demo data win.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.is_demo).toBe(false);
    expect(result.rows[0]!.buy_price).toBe(222);
  });

  test('displacement is scoped to the exact port and good', async () => {
    // The demo row at the same port for a DIFFERENT good must survive.
    const untouched = await rowsFor(PORT, OTHER_GOOD);
    expect(untouched.rows).toHaveLength(1);
    expect(untouched.rows[0]!.is_demo).toBe(true);
  });

  test('displacement is scoped per server, because servers are separate economies', async () => {
    await t.db.exec(`
      insert into price_submissions
        (server_id, port_id, good_id, buy_price, sell_price, source, is_demo, observed_at)
      values
        ('eu', '${PORT}', '${GOOD}', 999, 999, 'demo', true, now());
    `);

    const eu = (await t.db.query(
      `select buy_price, is_demo from prices_current
        where server_id = 'eu' and port_id = $1 and good_id = $2`,
      [PORT, GOOD],
    )) as { rows: { buy_price: number; is_demo: boolean }[] };

    // A real NA submission must not suppress the EU demo row.
    expect(eu.rows).toHaveLength(1);
    expect(eu.rows[0]!.is_demo).toBe(true);
    expect(eu.rows[0]!.buy_price).toBe(999);
  });

  test('among real submissions the most recent wins', async () => {
    await t.db.exec(`
      insert into price_submissions
        (server_id, port_id, good_id, buy_price, sell_price, source, is_demo, observed_at)
      values
        ('${SERVER}', '${OTHER_PORT}', '${GOOD}', 300, 300, 'manual', false, now() - interval '3 hours'),
        ('${SERVER}', '${OTHER_PORT}', '${GOOD}', 400, 400, 'manual', false, now() - interval '1 hour'),
        ('${SERVER}', '${OTHER_PORT}', '${GOOD}', 350, 350, 'manual', false, now() - interval '2 hours');
    `);

    const result = await rowsFor(OTHER_PORT, GOOD);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.buy_price).toBe(400);
  });

  test('flagged rows are ignored entirely', async () => {
    await t.db.exec(`
      insert into price_submissions
        (server_id, port_id, good_id, buy_price, sell_price, source, is_demo, observed_at, flagged, flag_reason)
      values
        ('${SERVER}', '${OTHER_PORT}', '${GOOD}', 99999, 99999, 'manual', false, now(), true, 'outside sanity band');
    `);

    const result = await rowsFor(OTHER_PORT, GOOD);
    // The flagged row is the newest, but must not be selected.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.buy_price).toBe(400);
  });

  test('a flagged real row does not displace a demo row', async () => {
    await t.db.exec(`
      insert into price_submissions
        (server_id, port_id, good_id, buy_price, sell_price, source, is_demo, observed_at)
      values
        ('${SERVER}', '${OTHER_PORT}', '${OTHER_GOOD}', 700, 700, 'demo', true, now() - interval '5 hours');

      insert into price_submissions
        (server_id, port_id, good_id, buy_price, sell_price, source, is_demo, observed_at, flagged, flag_reason)
      values
        ('${SERVER}', '${OTHER_PORT}', '${OTHER_GOOD}', 800, 800, 'manual', false, now(), true, 'bad reading');
    `);

    const result = await rowsFor(OTHER_PORT, OTHER_GOOD);
    // The only real submission is flagged, so it counts for nothing and the
    // demo row is still the best available answer.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.is_demo).toBe(true);
    expect(result.rows[0]!.buy_price).toBe(700);
  });

  test('the underlying table keeps every submission, because it is append-only', async () => {
    const all = (await t.db.query(
      `select count(*)::int as n from price_submissions
        where server_id = $1 and port_id = $2 and good_id = $3`,
      [SERVER, PORT, GOOD],
    )) as { rows: { n: number }[] };
    // One demo plus one real: the view hides the demo row, it does not delete
    // it. Phase 4 consensus weighting and price history both need the history.
    expect(all.rows[0]!.n).toBe(2);
  });
});
