import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDb, readSql, type TestDb } from './pg';

/**
 * The limit on account creation, against a real Postgres.
 *
 * Why this is worth its own file: `/api/anon-session` is unauthenticated by
 * definition -- its whole job is handing an identity to someone who has none --
 * and every account it creates is a permanent auth user and, from Phase 4
 * onward, a vote in the community consensus that decides which price is
 * believed. Unlimited accounts means unlimited votes. So this is not really
 * about Supabase MAU; it is about whether the data can be trusted at all.
 *
 * The counter it replaces lived in memory on one serverless instance and was
 * keyed on a header the caller wrote. Both failures are pinned below.
 */

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  await t.db.exec(readSql('migrations/0004_anon_session_limits.sql'));
}, 120_000);

afterAll(async () => {
  await t?.close();
});

const SUBJECT = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

async function charge(subject: string, hourLimit = 3, dayLimit = 100) {
  const rows = (await t.asServiceRole('select anon_session_charge($1, $2, $3) as result', [
    subject,
    hourLimit,
    dayLimit,
  ])) as { result: { allowed: boolean; hour: number; day: number } }[];
  return rows[0]!.result;
}

describe('the migration applies cleanly', () => {
  test('running it twice changes nothing and throws nothing', async () => {
    // Every deploy runs every migration. One that is not idempotent breaks the
    // build permanently the second time it is seen.
    await t.db.exec(readSql('migrations/0004_anon_session_limits.sql'));
    const rows = await t.db.query<{ n: number }>(
      `select count(*)::int as n from pg_proc where proname = 'anon_session_charge'`,
    );
    expect(rows.rows[0]!.n).toBe(1);
  });
});

describe('counting attempts', () => {
  test('each attempt counts once and the limit refuses the next', async () => {
    expect(await charge(SUBJECT)).toMatchObject({ hour: 1, allowed: true });
    expect(await charge(SUBJECT)).toMatchObject({ hour: 2, allowed: true });
    expect(await charge(SUBJECT)).toMatchObject({ hour: 3, allowed: true });
    expect(await charge(SUBJECT)).toMatchObject({ hour: 4, allowed: false });
  });

  test('a refused attempt still counts', async () => {
    // Otherwise being over the limit is free, and the refusal is something to
    // hammer through rather than something that stops anyone.
    const before = await charge(SUBJECT);
    const after = await charge(SUBJECT);
    expect(after.hour).toBe(before.hour + 1);
    expect(after.allowed).toBe(false);
  });

  test('one address being over its limit does not affect another', async () => {
    // The failure mode that would matter most in practice: a whole mobile
    // network shares one address behind carrier-grade NAT, so buckets must not
    // bleed into each other.
    expect(await charge(OTHER)).toMatchObject({ hour: 1, allowed: true });
  });

  test('the daily limit is enforced independently of the hourly one', async () => {
    const fresh = 'c'.repeat(64);
    // Spread over earlier hours: the hourly window is clear but the day is not,
    // which a single counter would miss entirely.
    await t.db.query(
      `insert into anon_session_usage (subject, hour, count) values
         ($1, date_trunc('hour', now()) - interval '5 hours', 4),
         ($1, date_trunc('hour', now()) - interval '2 hours', 4)`,
      [fresh],
    );
    const result = await charge(fresh, 100, 8);
    expect(result.hour).toBe(1);
    expect(result.day).toBe(9);
    expect(result.allowed).toBe(false);
  });

  test('attempts older than both windows are not counted and are cleaned up', async () => {
    const fresh = 'd'.repeat(64);
    await t.db.query(
      `insert into anon_session_usage (subject, hour, count)
       values ($1, now() - interval '5 days', 999)`,
      [fresh],
    );
    const result = await charge(fresh, 100, 10);
    expect(result.day).toBe(1);
    const left = await t.db.query<{ n: number }>(
      `select count(*)::int as n from anon_session_usage where subject = $1 and count = 999`,
      [fresh],
    );
    expect(left.rows[0]!.n).toBe(0);
  });
});

describe('no browser can reach or reset the counter', () => {
  test('a logged-out visitor cannot read it', async () => {
    // The visitor this endpoint serves is signed out by definition, so anon is
    // the role that matters here.
    await expect(t.asAnon('select * from anon_session_usage')).rejects.toThrow(
      /permission denied/i,
    );
  });

  test('a logged-in contributor cannot read or write it', async () => {
    await expect(
      t.asUser('11111111-1111-1111-1111-111111111111', 'select * from anon_session_usage'),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      t.asUser(
        '11111111-1111-1111-1111-111111111111',
        `insert into anon_session_usage (subject, hour, count) values ('x', now(), 0)`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  test('neither role may call the charging function', async () => {
    // security definer means the function runs with the owner's rights, so who
    // may CALL it is the entire access control story. If a browser could call
    // it, a browser could burn someone else's quota -- or its own, to nothing.
    await expect(t.asAnon(`select anon_session_charge('x', 1, 1)`)).rejects.toThrow(
      /permission denied/i,
    );
    await expect(
      t.asUser('11111111-1111-1111-1111-111111111111', `select anon_session_charge('x', 1, 1)`),
    ).rejects.toThrow(/permission denied/i);
  });
});
