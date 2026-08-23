import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from './pg';
import { applyPendingChanges } from '../../api/_auto';
import type { Migration } from '../../api/_sql';

/**
 * The automatic update path, end to end against a real database.
 *
 * The other auto tests stub PostgREST out, which proves the runner's decisions
 * but not that the database will actually accept what it sends. This stands
 * PostgREST up over a real Postgres instead: every request is executed AS THE
 * SERVICE ROLE, exactly as Supabase would, so a missing grant or a locked-down
 * table shows up here rather than in production.
 *
 * That distinction matters. A mocked fetch will happily answer 200 to a
 * request the real database would refuse.
 */

let t: TestDb;
const originalFetch = globalThis.fetch;

/** A stand-in for PostgREST, backed by the real database and the real role. */
function postgrestOver(db: TestDb): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const target = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    try {
      if (target.includes('/rpc/apply_migration')) {
        await db.asServiceRole('select apply_migration($1)', [body.migration_sql]);
        return new Response(null, { status: 204 });
      }

      if (target.includes('/schema_migrations')) {
        if (init?.method === 'POST') {
          await db.asServiceRole(
            `insert into schema_migrations (name, checksum) values ($1, $2)
             on conflict (name) do update set checksum = excluded.checksum`,
            [body.name, body.checksum],
          );
          return new Response(null, { status: 201 });
        }
        const rows = await db.asServiceRole('select name, checksum from schema_migrations');
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('not found', { status: 404 });
    } catch (error) {
      // Mirror how PostgREST surfaces a database refusal, so the runner sees
      // what it would really see.
      return new Response(error instanceof Error ? error.message : String(error), {
        status: 400,
      });
    }
  }) as typeof fetch;
}

beforeAll(async () => {
  t = await createTestDb({ seed: true });
  process.env.VITE_SUPABASE_URL = 'https://testref.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
  globalThis.fetch = postgrestOver(t);
}, 120_000);

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await t?.close();
});

describe('the service role can actually do what the runner asks of it', () => {
  test('re-applying the whole base schema succeeds against a live database', async () => {
    // This is the step that runs on every update. If the service role lacks a
    // grant anywhere in schema.sql, it fails here and not in a mock.
    const result = await applyPendingChanges([]);
    if (!result.ok) {
      throw new Error(
        `Base schema re-apply failed: ${result.steps.map((s) => s.detail).join(' | ')}`,
      );
    }
    expect(result.ok).toBe(true);
  }, 120_000);

  test('it can read schema_migrations, which the runner does on every update', async () => {
    const rows = await t.asServiceRole('select name, checksum from schema_migrations');
    expect(Array.isArray(rows)).toBe(true);
  });

  test('it can record an applied migration', async () => {
    await t.asServiceRole(
      `insert into schema_migrations (name, checksum) values ('probe.sql', 'abc')`,
    );
    const rows = (await t.asServiceRole(
      `select checksum from schema_migrations where name = 'probe.sql'`,
    )) as { checksum: string }[];
    expect(rows[0]!.checksum).toBe('abc');
    await t.asServiceRole(`delete from schema_migrations where name = 'probe.sql'`);
  });
});

describe('a real migration really changes the database', () => {
  const addColumn: Migration = {
    name: '9001_test_add_column.sql',
    checksum: 'testsum1',
    sql: `alter table ports add column if not exists test_note text;`,
  };

  test('applies the change and records it in one pass', async () => {
    const result = await applyPendingChanges([addColumn]);
    expect(result.ok, result.steps.map((s) => s.detail).join(' | ')).toBe(true);
    expect(result.applied).toEqual(['9001_test_add_column.sql']);

    const columns = (await t.db.query(`
      select column_name from information_schema.columns
       where table_name = 'ports' and column_name = 'test_note'
    `)) as { rows: unknown[] };
    expect(columns.rows).toHaveLength(1);
  }, 120_000);

  test('a second pass skips it rather than running it again', async () => {
    const result = await applyPendingChanges([addColumn]);
    expect(result.ok).toBe(true);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['9001_test_add_column.sql']);
  }, 120_000);

  test('an edited migration halts the update instead of guessing', async () => {
    const edited: Migration = { ...addColumn, checksum: 'changed' };
    const result = await applyPendingChanges([edited]);
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)!.detail).toMatch(/file has changed/i);
  }, 120_000);

  test('a broken migration fails loudly and is not recorded', async () => {
    const broken: Migration = {
      name: '9002_broken.sql',
      checksum: 'testsum2',
      sql: 'alter table nonexistent_table add column x int;',
    };
    const result = await applyPendingChanges([broken]);
    expect(result.ok).toBe(false);
    expect(result.applied).toEqual([]);

    // Nothing half-applied should be left recorded as done, or the next run
    // would skip a migration that never actually ran.
    const rows = (await t.asServiceRole(
      `select name from schema_migrations where name = '9002_broken.sql'`,
    )) as unknown[];
    expect(rows).toHaveLength(0);
  }, 120_000);

  test('the database is still intact and secure afterwards', async () => {
    const unprotected = (await t.db.query(`
      select c.relname from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
       order by 1
    `)) as { rows: { relname: string }[] };
    expect(unprotected.rows.map((r) => r.relname)).toEqual([]);

    const counts = (await t.db.query(`
      select (select count(*)::int from ports) as ports,
             (select count(*)::int from goods) as goods
    `)) as { rows: { ports: number; goods: number }[] };
    expect(counts.rows[0]).toEqual({ ports: 42, goods: 61 });
  });
});
