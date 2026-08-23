import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from './pg';

/**
 * port_state_current -- the view that resolves what a port's tax, shallow-water
 * limit and owner currently are.
 *
 * Port state is append-only for the same reason prices are (SPEC.md 3.2):
 * corrections are new rows, never edits. Two rules make it work:
 *
 *   * each FIELD resolves independently, so correcting the tax does not wipe
 *     out a shallow-water limit somebody else recorded
 *   * demo rows are ignored for a port as soon as any real submission exists
 */

let t: TestDb;
const SERVER = 'na';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';

interface StateRow {
  tax_percent: string | number | null;
  docking_fee: number | null;
  min_ship_rate: number | null;
  controlling_faction: string | null;
  port_type: string | null;
  has_market: boolean | null;
  is_demo: boolean;
}

async function stateOf(portId: string): Promise<StateRow | undefined> {
  const result = await t.db.query(
    `select * from port_state_current where server_id = $1 and port_id = $2`,
    [SERVER, portId],
  );
  return (result.rows as StateRow[])[0];
}

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

beforeAll(async () => {
  t = await createTestDb({ seed: true });
  await t.db.exec(`
    insert into auth.users (id, email) values
      ('${ALICE}', 'alice@example.com'),
      ('${BOB}',   'bob@example.com'),
      ('${ADMIN}', 'admin@example.com');
    insert into profiles (id, display_name, server_id) values
      ('${ALICE}', 'Alice', 'na'),
      ('${BOB}',   'Bob',   'na'),
      ('${ADMIN}', 'Admin', 'na');
    insert into admins (user_id) values ('${ADMIN}');
  `);
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe('each field resolves on its own', () => {
  test('a later submission that omits a field does not erase it', async () => {
    // Alice records the shallow-water limit. A week later Bob records only the
    // tax. The limit must survive: Bob did not say it had gone, he just did
    // not mention it.
    await t.db.exec(`
      insert into port_state_submissions
        (server_id, port_id, min_ship_rate, submitted_by, observed_at)
      values ('${SERVER}', 'fiji', 6, '${ALICE}', now() - interval '7 days');

      insert into port_state_submissions
        (server_id, port_id, tax_percent, submitted_by, observed_at)
      values ('${SERVER}', 'fiji', 8, '${BOB}', now() - interval '1 hour');
    `);

    const state = await stateOf('fiji');
    expect(Number(state!.tax_percent)).toBe(8);
    expect(state!.min_ship_rate).toBe(6);
  });

  test('the newest value of a field wins when two people record it', async () => {
    await t.db.exec(`
      insert into port_state_submissions
        (server_id, port_id, tax_percent, submitted_by, observed_at)
      values ('${SERVER}', 'fiji', 11, '${ALICE}', now());
    `);
    expect(Number((await stateOf('fiji'))!.tax_percent)).toBe(11);
  });

  test('an older submission cannot overwrite a newer one', async () => {
    await t.db.exec(`
      insert into port_state_submissions
        (server_id, port_id, tax_percent, submitted_by, observed_at)
      values ('${SERVER}', 'fiji', 4, '${BOB}', now() - interval '30 days');
    `);
    expect(Number((await stateOf('fiji'))!.tax_percent)).toBe(11);
  });

  test('a field nobody has recorded stays null rather than becoming zero', async () => {
    // Docking fee has never been observed anywhere in the game.
    expect((await stateOf('fiji'))!.docking_fee).toBeNull();
  });

  test('a port nobody has recorded at all has no row', async () => {
    expect(await stateOf('charleston')).toBeUndefined();
  });
});

describe('demo rows give way to real observations', () => {
  test('a demo row is used when nothing real exists', async () => {
    await t.db.exec(`
      insert into port_state_submissions
        (server_id, port_id, tax_percent, min_ship_rate, source, is_demo, observed_at)
      values ('${SERVER}', 'st_john', 12, null, 'demo', true, now());
    `);

    const state = await stateOf('st_john');
    expect(Number(state!.tax_percent)).toBe(12);
    expect(state!.is_demo).toBe(true);
  });

  test('one real observation displaces the demo row entirely', async () => {
    await t.db.exec(`
      insert into port_state_submissions
        (server_id, port_id, tax_percent, submitted_by, observed_at)
      values ('${SERVER}', 'st_john', 9, '${ALICE}', now() - interval '2 days');
    `);

    const state = await stateOf('st_john');
    // Even though the demo row is NEWER, the real one wins. A seeded value
    // whose server was never recorded must not outlive a real sighting.
    expect(Number(state!.tax_percent)).toBe(9);
    expect(state!.is_demo).toBe(false);
  });

  test('displacement is per port, not global', async () => {
    // fiji has real rows; a demo row at another port is untouched by that.
    await t.db.exec(`
      insert into port_state_submissions
        (server_id, port_id, tax_percent, source, is_demo, observed_at)
      values ('${SERVER}', 'los_catuano', 8, 'demo', true, now());
    `);
    expect((await stateOf('los_catuano'))!.is_demo).toBe(true);
  });

  test('displacement is per server, because servers are separate economies', async () => {
    await t.db.exec(`
      insert into port_state_submissions
        (server_id, port_id, tax_percent, source, is_demo, observed_at)
      values ('eu', 'fiji', 5, 'demo', true, now());
    `);
    const eu = (await t.db.query(
      `select tax_percent, is_demo from port_state_current
        where server_id = 'eu' and port_id = 'fiji'`,
    )) as { rows: { tax_percent: string | number; is_demo: boolean }[] };
    expect(eu.rows).toHaveLength(1);
    expect(eu.rows[0]!.is_demo).toBe(true);
    expect(Number(eu.rows[0]!.tax_percent)).toBe(5);
  });

  test('a flagged real row does not count as displacing a demo row', async () => {
    await t.db.exec(`
      insert into port_state_submissions
        (server_id, port_id, tax_percent, source, is_demo, observed_at)
      values ('${SERVER}', 'devios', 7, 'demo', true, now() - interval '1 day');

      insert into port_state_submissions
        (server_id, port_id, tax_percent, submitted_by, observed_at, flagged, flag_reason)
      values ('${SERVER}', 'devios', 99, '${BOB}', now(), true, 'impossible rate');
    `);

    const state = await stateOf('devios');
    expect(state!.is_demo).toBe(true);
    expect(Number(state!.tax_percent)).toBe(7);
  });
});

describe('port state is append-only, like prices', () => {
  test('anyone may read it, including logged-out visitors', async () => {
    const rows = await t.asAnon(
      `select count(*)::int n from port_state_current where server_id = '${SERVER}'`,
    );
    expect((rows as { n: number }[])[0]!.n).toBeGreaterThan(0);
  });

  test('a logged-out visitor cannot record port state', async () => {
    await expectRejected(
      t.asAnon(
        `insert into port_state_submissions (server_id, port_id, tax_percent, source)
         values ('${SERVER}', 'nevis', 8, 'manual')`,
      ),
    );
  });

  test('a logged-in user may record what they saw', async () => {
    await t.asUser(
      BOB,
      `insert into port_state_submissions (server_id, port_id, tax_percent, submitted_by, source)
       values ('${SERVER}', 'nevis', 8, '${BOB}', 'manual')`,
    );
    expect(Number((await stateOf('nevis'))!.tax_percent)).toBe(8);
  });

  test('a user cannot record port state under someone else’s name', async () => {
    await expectRejected(
      t.asUser(
        BOB,
        `insert into port_state_submissions (server_id, port_id, tax_percent, submitted_by, source)
         values ('${SERVER}', 'aruba', 8, '${ALICE}', 'manual')`,
      ),
    );
  });

  test('a user cannot pass their own observation off as seeded demo data', async () => {
    await expectRejected(
      t.asUser(
        BOB,
        `insert into port_state_submissions
           (server_id, port_id, tax_percent, submitted_by, source, is_demo)
         values ('${SERVER}', 'aruba', 8, '${BOB}', 'demo', true)`,
      ),
    );
  });

  test('nobody can edit a submission, not even their own', async () => {
    const changed = await t.asUser(
      BOB,
      `update port_state_submissions set tax_percent = 1
        where submitted_by = '${BOB}' returning id`,
    );
    expect(changed).toHaveLength(0);
    expect(Number((await stateOf('nevis'))!.tax_percent)).toBe(8);
  });

  test('nobody can delete a submission', async () => {
    await expectRejected(t.asUser(BOB, 'delete from port_state_submissions'));
    await expectRejected(t.asUser(ADMIN, 'delete from port_state_submissions'));
  });

  test('an admin may flag a bad submission but not rewrite it', async () => {
    await t.asUser(
      ADMIN,
      `update port_state_submissions set flagged = true, flag_reason = 'wrong server'
        where port_id = 'nevis'`,
    );
    // Flagged, so the view drops it and the port falls back to having no state.
    expect(await stateOf('nevis')).toBeUndefined();

    await expectRejected(
      t.asUser(ADMIN, `update port_state_submissions set tax_percent = 1 where port_id = 'nevis'`),
      /append-only/,
    );
  });

  test('the history survives: correcting a port never destroys what came before', async () => {
    const rows = (await t.db.query(
      `select count(*)::int as n from port_state_submissions
        where server_id = $1 and port_id = 'fiji'`,
      [SERVER],
    )) as { rows: { n: number }[] };
    // Four submissions for Fiji across these tests, all still on record. Guild
    // capture makes that history the interesting part.
    expect(rows.rows[0]!.n).toBeGreaterThanOrEqual(4);
  });
});
