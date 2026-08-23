import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from './pg';

/**
 * schema_state(): the status page's only way to know the database is current.
 *
 * Every other check on that page proves the database was set up correctly
 * ONCE. None of them notice it falling behind afterwards, and falling behind
 * is the failure that actually happened here: the build step deliberately
 * never fails a deployment, so a dead migration path is indistinguishable
 * from a normal deploy.
 *
 * These run against real Postgres rather than a mocked RPC, deliberately. The
 * lesson this project already paid for once: a mocked fetch answers 200 to a
 * request the real database refuses, and 202 passing tests missed a missing
 * table grant because of exactly that. What matters here is whether Postgres
 * accepts the function and whether the GRANT actually lets a logged-out
 * visitor call it, and only Postgres can answer either.
 */

let t: TestDb;

interface State {
  auto_migrations_ready: boolean;
  applied_count: number;
  applied: { name: string; applied_at: string }[];
}

async function stateAsAnon(): Promise<State> {
  const rows = (await t.asAnon('select public.schema_state() as s')) as { s: State }[];
  return rows[0]!.s;
}

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.close();
});

describe('a logged-out visitor can ask', () => {
  test('anon may execute it, because the status page runs in the browser', async () => {
    // If the grant were missing this throws, and the status page would show a
    // permission error to every visitor instead of a green tick.
    const state = await stateAsAnon();
    expect(state).toBeTruthy();
  });

  test('it confirms the migration function exists', async () => {
    // apply_migration is created by schema.sql, which this database ran. A
    // false here in production means the schema predates that, which is
    // precisely the condition the status page needs to surface.
    const state = await stateAsAnon();
    expect(state.auto_migrations_ready).toBe(true);
  });

  test('a fresh database honestly reports nothing applied', async () => {
    const state = await stateAsAnon();
    expect(Number(state.applied_count)).toBe(0);
    expect(state.applied).toEqual([]);
  });
});

describe('it reflects what has actually been recorded', () => {
  test('a recorded migration shows up by name', async () => {
    await t.asServiceRole(
      `insert into schema_migrations (name, checksum) values ('0001_value_constraints.sql', 'abc123')`,
    );
    const state = await stateAsAnon();
    expect(Number(state.applied_count)).toBe(1);
    expect(state.applied.map((row) => row.name)).toEqual(['0001_value_constraints.sql']);
  });

  test('several are returned in filename order, which is the order they run', async () => {
    await t.asServiceRole(
      `insert into schema_migrations (name, checksum) values ('0003_c.sql', 'c'), ('0002_b.sql', 'b')`,
    );
    const state = await stateAsAnon();
    expect(state.applied.map((row) => row.name)).toEqual([
      '0001_value_constraints.sql',
      '0002_b.sql',
      '0003_c.sql',
    ]);
  });

  test('each entry carries when it was applied', async () => {
    const state = await stateAsAnon();
    for (const row of state.applied) {
      expect(Date.parse(row.applied_at), `${row.name} has no usable timestamp`).not.toBeNaN();
    }
  });
});

describe('it gives away nothing it should not', () => {
  test('no checksums and no SQL reach the browser', async () => {
    // The function is security definer, so it is a hole punched through RLS on
    // purpose. It must stay a narrow one: names and times, nothing else.
    const state = await stateAsAnon();
    const serialised = JSON.stringify(state);
    expect(serialised).not.toContain('abc123');
    expect(serialised).not.toMatch(/create |alter |drop /i);
    for (const row of state.applied) {
      expect(Object.keys(row).sort()).toEqual(['applied_at', 'name']);
    }
  });

  test('the table itself stays unreadable without the function', async () => {
    // The whole reason schema_state exists: schema_migrations has RLS on and
    // no policies, so this narrow function is the only window onto it.
    let rows: unknown[] | null = null;
    let failed = false;
    try {
      rows = await t.asAnon('select * from schema_migrations');
    } catch {
      failed = true;
    }
    // Either outcome is correct -- refused outright, or allowed but returning
    // nothing. What must never happen is the rows coming back.
    expect(failed || (rows?.length ?? 0) === 0).toBe(true);
  });

  test('a visitor cannot call apply_migration, only read the report', async () => {
    // Worth asserting next to the readable one: adding a function anon may
    // call is the moment to re-check that the dangerous neighbour stayed shut.
    await expect(t.asAnon(`select public.apply_migration('select 1')`)).rejects.toThrow();
  });
});
