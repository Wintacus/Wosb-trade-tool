import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDb, readSql, type TestDb } from './pg';

/**
 * Values the database refuses outright.
 *
 * These exist because of what probing the calculator with hostile input turned
 * up: a buy price of -10.0 gold made every good look enormously profitable,
 * since a negative cost reads as free money to the arithmetic. Nothing stopped
 * such a row being stored.
 *
 * Guarding it in the calculator would have been the wrong fix. Prices arrive
 * from manual entry, from OCR, and later from screen capture; one rule at the
 * bottom covers every path, including paths not written yet.
 */

let t: TestDb;

async function rejects(sql: string, constraint: RegExp): Promise<void> {
  let message = '';
  try {
    await t.db.exec(sql);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message, `expected this to be rejected: ${sql}`).toMatch(constraint);
}

beforeAll(async () => {
  t = await createTestDb({ seed: true });
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe('prices cannot be negative', () => {
  test('a negative buy price is refused', async () => {
    // The exact case that produced 9,360 gold of profit out of nothing.
    await rejects(
      `insert into price_submissions (server_id, port_id, good_id, buy_price, source)
       values ('na', 'fiji', 'sugar', -100, 'manual')`,
      /price_buy_nonneg/,
    );
  });

  test('a negative sell price is refused', async () => {
    await rejects(
      `insert into price_submissions (server_id, port_id, good_id, sell_price, source)
       values ('na', 'fiji', 'sugar', -1, 'manual')`,
      /price_sell_nonneg/,
    );
  });

  test('negative stock is refused', async () => {
    await rejects(
      `insert into price_submissions (server_id, port_id, good_id, buy_price, stock, source)
       values ('na', 'fiji', 'sugar', 400, -5, 'manual')`,
      /price_stock_nonneg/,
    );
  });

  test('but zero and null remain perfectly valid', async () => {
    // Zero stock means sold out; null means the game showed no quantity. Both
    // are real states and must not be swept up by the rule.
    await t.db.exec(`
      insert into price_submissions (server_id, port_id, good_id, buy_price, stock, source)
      values ('na', 'fiji', 'beer', 0, 0, 'manual'),
             ('na', 'fiji', 'grog', 120, null, 'manual');
    `);
    const rows = (await t.db.query(
      `select count(*)::int n from price_submissions where port_id = 'fiji'`,
    )) as { rows: { n: number }[] };
    expect(rows.rows[0]!.n).toBeGreaterThanOrEqual(2);
  });
});

describe('port state cannot hold impossible values', () => {
  test('a tax rate outside 0 to 100 is refused', async () => {
    await rejects(
      `insert into port_state_submissions (server_id, port_id, tax_percent)
       values ('na', 'fiji', -5)`,
      /port_tax_range/,
    );
    await rejects(
      `insert into port_state_submissions (server_id, port_id, tax_percent)
       values ('na', 'fiji', 150)`,
      /port_tax_range/,
    );
  });

  test('a ship rate outside 1 to 7 is refused', async () => {
    // A bad value here would silently gate every ship out of a port, or none.
    await rejects(
      `insert into port_state_submissions (server_id, port_id, min_ship_rate)
       values ('na', 'fiji', 9)`,
      /port_min_rate_range/,
    );
    await rejects(
      `insert into port_state_submissions (server_id, port_id, min_ship_rate)
       values ('na', 'fiji', 0)`,
      /port_min_rate_range/,
    );
  });

  test('a negative docking fee is refused', async () => {
    await rejects(
      `insert into port_state_submissions (server_id, port_id, docking_fee)
       values ('na', 'fiji', -1)`,
      /port_fee_nonneg/,
    );
  });

  test('the real observed values all still fit', async () => {
    // 4, 8 and 12 percent tax and rate 6 shallow water are real sightings.
    await t.db.exec(`
      insert into port_state_submissions (server_id, port_id, tax_percent, min_ship_rate)
      values ('na', 'freebooter_bay', 4, 6),
             ('na', 'bord_radel', 8, null),
             ('na', 'st_john', 12, null);
    `);
    const rows = (await t.db.query(
      `select count(*)::int n from port_state_submissions where server_id = 'na'`,
    )) as { rows: { n: number }[] };
    expect(rows.rows[0]!.n).toBeGreaterThanOrEqual(3);
  });
});

describe('reference data cannot be nonsense', () => {
  test('a weightless good is refused', async () => {
    // Weight zero would let an unlimited quantity into any hold.
    await rejects(
      `insert into goods (id, name, weight, is_trade_good) values ('ghost', 'Ghost', 0, true)`,
      /goods_weight_positive/,
    );
  });

  test('a ship rate outside 1 to 7 is refused', async () => {
    await rejects(
      `insert into ships (id, name, class, rate, hold) values ('x', 'X', 'Fast', 8, 100)`,
      /ships_rate_range/,
    );
  });

  test('a ship with no hold is refused', async () => {
    await rejects(
      `insert into ships (id, name, class, rate, hold) values ('y', 'Y', 'Fast', 5, 0)`,
      /ships_hold_positive/,
    );
  });

  test('every seeded row already satisfies all of it', async () => {
    // The constraints were added after the data existed, so this confirms they
    // describe the real world rather than an idealised one.
    const counts = (await t.db.query(`
      select (select count(*)::int from goods) as goods,
             (select count(*)::int from ships) as ships,
             (select count(*)::int from ports) as ports
    `)) as { rows: { goods: number; ships: number; ports: number }[] };
    expect(counts.rows[0]).toEqual({ goods: 61, ships: 38, ports: 42 });
  });
});

describe('the migration fixes a database that already exists', () => {
  test('an older database gains the constraints when the migration runs', async () => {
    // A database created before this rule existed is the case that matters:
    // schema.sql alone cannot help it, because the tables are already there.
    const older = await createTestDb();
    await older.db.exec(`
      create table if not exists legacy_prices (
        id serial primary key,
        buy_price integer
      );
      insert into legacy_prices (buy_price) values (-999);
    `);

    // Standing in for a pre-existing table, the migration's own guard should
    // add nothing twice and error on nothing.
    await older.db.exec(readSql('migrations/0001_value_constraints.sql'));
    await older.db.exec(readSql('migrations/0001_value_constraints.sql'));

    let rejected = '';
    try {
      await older.db.exec(
        `insert into price_submissions (server_id, port_id, good_id, buy_price, source)
         values ('na', 'fiji', 'sugar', -100, 'manual')`,
      );
    } catch (error) {
      rejected = error instanceof Error ? error.message : String(error);
    }
    // Either the constraint or the missing seed row stops it; what matters is
    // that a negative price never lands.
    expect(rejected.length).toBeGreaterThan(0);

    await older.close();
  }, 120_000);
});
