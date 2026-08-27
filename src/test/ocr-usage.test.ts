import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDb, readSql, type TestDb } from './pg';

/**
 * The rate limit, run against a real Postgres.
 *
 * This is the only thing standing between one determined caller and the whole
 * month's Anthropic budget, so it is worth more than a unit test of the
 * JavaScript around it. Everything here exercises the actual migration file
 * that gets applied on deploy -- if this passes and production behaves
 * differently, the SQL is not the reason.
 */

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  await t.db.exec(readSql('migrations/0003_ocr_usage.sql'));
}, 120_000);

afterAll(async () => {
  await t?.close();
});

const USER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

async function charge(user: string, hourLimit = 3, dayLimit = 100) {
  const rows = (await t.asServiceRole('select ocr_charge($1, $2, $3) as result', [
    user,
    hourLimit,
    dayLimit,
  ])) as { result: { allowed: boolean; hour: number; day: number } }[];
  return rows[0]!.result;
}

describe('the migration applies cleanly', () => {
  test('running it twice changes nothing and throws nothing', async () => {
    // Every deploy runs every migration. One that is not idempotent breaks the
    // build for good the second time it is seen.
    await t.db.exec(readSql('migrations/0003_ocr_usage.sql'));
    const rows = await t.db.query<{ n: number }>(
      `select count(*)::int as n from pg_proc where proname = 'ocr_charge'`,
    );
    expect(rows.rows[0]!.n).toBe(1);
  });
});

describe('counting what an account has spent', () => {
  test('each call counts once and the limit stops the caller', async () => {
    expect(await charge(USER)).toMatchObject({ hour: 1, allowed: true });
    expect(await charge(USER)).toMatchObject({ hour: 2, allowed: true });
    expect(await charge(USER)).toMatchObject({ hour: 3, allowed: true });
    // The fourth is over a limit of three.
    expect(await charge(USER)).toMatchObject({ hour: 4, allowed: false });
  });

  test('a refused request still counts', async () => {
    // Otherwise a caller who is already over the limit pays nothing for
    // hammering the endpoint, and the refusal is free to ignore.
    const before = await charge(USER);
    const after = await charge(USER);
    expect(after.hour).toBe(before.hour + 1);
    expect(after.allowed).toBe(false);
  });

  test('one account being over its limit does not affect another', async () => {
    expect(await charge(OTHER)).toMatchObject({ hour: 1, allowed: true });
  });

  test('the daily limit is enforced independently of the hourly one', async () => {
    const fresh = '33333333-3333-3333-3333-333333333333';
    // Spread across earlier hours, so the hourly window is clear but the day
    // is not -- the case a single counter would miss entirely.
    // Seeded directly, because nothing but ocr_charge is granted on this table
    // -- which is the point of the tests below.
    await t.db.query(
      `insert into ocr_usage (user_id, hour, count) values
         ($1, date_trunc('hour', now()) - interval '3 hours', 5),
         ($1, date_trunc('hour', now()) - interval '2 hours', 5)`,
      [fresh],
    );
    const result = await charge(fresh, 100, 10);
    expect(result.hour).toBe(1);
    expect(result.day).toBe(11);
    expect(result.allowed).toBe(false);
  });

  test('usage older than both windows is not counted and is cleaned up', async () => {
    const fresh = '44444444-4444-4444-4444-444444444444';
    await t.db.query(
      `insert into ocr_usage (user_id, hour, count)
       values ($1, now() - interval '5 days', 999)`,
      [fresh],
    );
    const result = await charge(fresh, 100, 10);
    expect(result.day).toBe(1);
    const left = await t.db.query<{ n: number }>(
      `select count(*)::int as n from ocr_usage where user_id = $1 and count = 999`,
      [fresh],
    );
    expect(left.rows[0]!.n).toBe(0);
  });
});

describe('no browser can reach the counter', () => {
  test('a logged-in contributor cannot read anyone usage, including their own', async () => {
    // Both gates are shut: no grant, and RLS with no policy behind it. Usage is
    // between the function and the database -- a client that could read it
    // could also learn how close another account is to its limit.
    await expect(t.asUser(USER, 'select * from ocr_usage')).rejects.toThrow(/permission denied/i);
  });

  test('a logged-in contributor cannot write to the counter', async () => {
    await expect(
      t.asUser(USER, `insert into ocr_usage (user_id, hour, count) values ($1, now(), 0)`, [USER]),
    ).rejects.toThrow();
  });

  test('a logged-out visitor cannot read it either', async () => {
    await expect(t.asAnon('select * from ocr_usage')).rejects.toThrow(/permission denied/i);
  });

  test('neither role may call the charging function to reset itself', async () => {
    // security definer means whoever may CALL it gets the owner's rights, so
    // the grant is the entire access control story for this function.
    await expect(t.asUser(USER, `select ocr_charge($1, 1, 1)`, [USER])).rejects.toThrow(
      /permission denied/i,
    );
    await expect(t.asAnon(`select ocr_charge($1, 1, 1)`, [USER])).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe('corrections can be recorded but not read back', () => {
  test('a contributor may log a correction', async () => {
    await t.asUser(
      USER,
      `insert into ocr_corrections (screen_type, field_name, ocr_value, corrected_value)
       values ('market', 'copper.sell', '22.0', '2.2')`,
    );
    // Written, but invisible to the writer: this table is for spotting
    // systematic weakness, not a feed anyone browses.
    expect(await t.asUser(USER, 'select * from ocr_corrections')).toHaveLength(0);
  });

  test('a logged-out visitor may not log anything', async () => {
    await expect(
      t.asAnon(
        `insert into ocr_corrections (screen_type, field_name) values ('market', 'x')`,
      ),
    ).rejects.toThrow();
  });
});
