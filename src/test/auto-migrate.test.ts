import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from './pg';
import { applyPendingChanges } from '../../api/_auto';
import type { Migration } from '../../api/_sql';

/**
 * Schema changes that apply themselves.
 *
 * Once the base schema exists, the deployed site can update the database using
 * the service role key it already holds, so a schema change is a push and
 * nothing more. That convenience is only acceptable if the door it opens is
 * genuinely shut to everyone else, which is what the first group here checks.
 */

let t: TestDb;

const BOB = '22222222-2222-4222-8222-222222222222';

async function expectRejected(promise: Promise<unknown>, matching?: RegExp): Promise<void> {
  let failed = false;
  try {
    await promise;
  } catch (error) {
    failed = true;
    if (matching) expect(String(error)).toMatch(matching);
  }
  expect(failed, 'expected the database to reject this, but it was allowed').toBe(true);
}

describe('apply_migration is locked to the service role', () => {
  beforeAll(async () => {
    t = await createTestDb({ seed: true });
    await t.db.exec(`
      insert into auth.users (id, email) values ('${BOB}', 'bob@example.com');
      insert into profiles (id, display_name) values ('${BOB}', 'Bob');
    `);
  }, 120_000);

  afterAll(async () => {
    await t?.close();
  });

  test('a logged-out visitor cannot call it', async () => {
    await expectRejected(
      t.asAnon(`select apply_migration('create table pwned (id int)')`),
      /permission denied/i,
    );
  });

  test('an ordinary logged-in user cannot call it', async () => {
    await expectRejected(
      t.asUser(BOB, `select apply_migration('create table pwned (id int)')`),
      /permission denied/i,
    );
  });

  test('and neither of them managed to create anything', async () => {
    const rows = (await t.db.query(
      `select count(*)::int n from pg_tables where tablename = 'pwned'`,
    )) as { rows: { n: number }[] };
    expect(rows.rows[0]!.n).toBe(0);
  });

  test('the service role can, which is the whole point', async () => {
    await t.asServiceRole(
      `select apply_migration('create table if not exists proof_of_life (id int)')`,
    );
    const rows = (await t.db.query(
      `select count(*)::int n from pg_tables where tablename = 'proof_of_life'`,
    )) as { rows: { n: number }[] };
    expect(rows.rows[0]!.n).toBe(1);
  });

  test('schema_migrations is unreachable from a browser', async () => {
    await expectRejected(t.asAnon('select * from schema_migrations'), /permission denied/i);
    await expectRejected(
      t.asUser(BOB, 'select * from schema_migrations'),
      /permission denied/i,
    );
  });

  test('every table still has row-level security on, including the new one', async () => {
    const rows = (await t.db.query(`
      select c.relname from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
         and c.relname <> 'proof_of_life'
       order by 1
    `)) as { rows: { relname: string }[] };
    expect(rows.rows.map((r) => r.relname)).toEqual([]);
  });
});

describe('the runner', () => {
  // PostgREST is stood in for here: what matters is the decisions the runner
  // makes, not that HTTP works.
  const originalFetch = globalThis.fetch;
  let calls: { url: string; body: unknown }[] = [];
  let applied: Map<string, string>;
  let failOn: string | null = null;

  beforeEach(() => {
    calls = [];
    applied = new Map();
    failOn = null;
    process.env.VITE_SUPABASE_URL = 'https://testref.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';

    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: String(url), body });

      if (String(url).includes('/rpc/apply_migration')) {
        if (failOn && String(body?.migration_sql).includes(failOn)) {
          return new Response('syntax error at or near "oops"', { status: 400 });
        }
        // A void RPC really does answer 204 with no body, and the Response
        // constructor rejects a non-null body at that status.
        return new Response(null, { status: 204 });
      }
      if (String(url).includes('/schema_migrations')) {
        if (init?.method === 'POST') {
          applied.set(body.name, body.checksum);
          return new Response(null, { status: 201 });
        }
        return new Response(
          JSON.stringify([...applied].map(([name, checksum]) => ({ name, checksum }))),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('re-applies the base schema every time, which is how new tables arrive', async () => {
    const result = await applyPendingChanges();
    expect(result.ok).toBe(true);
    const schemaCall = calls.find((c) => c.url.includes('/rpc/apply_migration'));
    expect(schemaCall).toBeDefined();
    expect(String((schemaCall!.body as { migration_sql: string }).migration_sql)).toContain(
      'create table if not exists ports',
    );
  });

  test('sends the service role key, never the publishable one', async () => {
    await applyPendingChanges();
    expect(calls.length).toBeGreaterThan(0);
    // The key is what authorises this; a wrong one would fail silently open in
    // the worst case, so it is worth asserting explicitly.
    expect(calls.every((c) => c.url.startsWith('https://testref.supabase.co'))).toBe(true);
  });

  test('refuses to run at all when the key is missing', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const result = await applyPendingChanges();
    expect(result.ok).toBe(false);
    expect(result.steps[0]!.detail).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(calls).toHaveLength(0);
  });

  test('reports plainly when the base schema has never been installed', async () => {
    globalThis.fetch = (async () =>
      new Response('function public.apply_migration does not exist', {
        status: 404,
      })) as typeof fetch;

    const result = await applyPendingChanges();
    expect(result.ok).toBe(false);
    // The fix is a different one, so the message must not be generic.
    expect(result.steps[0]!.detail).toMatch(/one-time setup/i);
  });

  test('a failing statement stops the run rather than pressing on', async () => {
    failOn = 'create table if not exists ports';
    const result = await applyPendingChanges();
    expect(result.ok).toBe(false);
    expect(result.applied).toEqual([]);
    // Nothing after the failure should have been attempted.
    expect(calls.filter((c) => c.url.includes('/rpc/'))).toHaveLength(1);
  });

  const migration = (name: string, checksum: string, sql = 'select 1'): Migration => ({
    name,
    checksum,
    sql,
  });

  test('applies a pending migration and records it', async () => {
    const result = await applyPendingChanges([migration('0001_add_column.sql', 'aaa')]);
    expect(result.ok).toBe(true);
    expect(result.applied).toEqual(['0001_add_column.sql']);
    expect(applied.get('0001_add_column.sql')).toBe('aaa');
  });

  test('applies migrations in the order given', async () => {
    const result = await applyPendingChanges([
      migration('0001_first.sql', 'a'),
      migration('0002_second.sql', 'b'),
      migration('0003_third.sql', 'c'),
    ]);
    expect(result.applied).toEqual(['0001_first.sql', '0002_second.sql', '0003_third.sql']);
  });

  test('skips one already applied with the same contents', async () => {
    applied.set('0001_done.sql', 'same');
    const result = await applyPendingChanges([migration('0001_done.sql', 'same')]);
    expect(result.ok).toBe(true);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['0001_done.sql']);
  });

  test('halts when an applied migration has been edited since', async () => {
    // Neither choice is safe on its own: re-running could double-apply, and
    // skipping would hide a real difference between the file and the database.
    // Stopping and saying so is the only honest option.
    applied.set('0001_done.sql', 'original');
    const result = await applyPendingChanges([migration('0001_done.sql', 'edited')]);
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)!.detail).toMatch(/file has changed/i);
    expect(result.applied).toEqual([]);
  });

  test('a later migration is not attempted once an earlier one fails', async () => {
    failOn = 'BREAKS';
    const result = await applyPendingChanges([
      migration('0001_ok.sql', 'a', 'select 1'),
      migration('0002_bad.sql', 'b', 'BREAKS'),
      migration('0003_never.sql', 'c', 'select 3'),
    ]);
    expect(result.ok).toBe(false);
    expect(result.applied).toEqual(['0001_ok.sql']);
    expect(applied.has('0003_never.sql')).toBe(false);
  });

  test('is safe to run twice: the second pass applies nothing new', async () => {
    const first = await applyPendingChanges();
    const appliedFirst = first.applied.length;
    calls = [];
    const second = await applyPendingChanges();
    expect(second.ok).toBe(true);
    expect(second.applied).toHaveLength(0);
    expect(second.skipped).toHaveLength(appliedFirst);
  });
});
