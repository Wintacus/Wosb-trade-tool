import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDb, type TestDb } from './pg';

/**
 * Row-level security verification.
 *
 * SPEC.md 3.2 says to VERIFY this rather than assume it: "attempt to read
 * another profile's presets with the anon key. If it succeeds, the policy is
 * wrong." This does exactly that, against the real schema.sql, on every push.
 *
 * RLS is the Postgres feature that checks a rule on every row before anyone
 * can read or write it. It matters because the browser talks to the database
 * directly, so the database has to be the thing enforcing access, not the app.
 */

let t: TestDb;

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';

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

  // Seed identities as the owner, which bypasses RLS the way the service role
  // key does. This is the only place that privilege is used.
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

    insert into ship_presets (profile_id, name, ship_id, upgrade_ids) values
      ('${ALICE}', 'Alice trader', 'friede', '{}');

    insert into saved_routes (profile_id, origin_port_id, destination_port_id, label) values
      ('${ALICE}', 'fiji', 'st_john', 'Alice route');
  `);
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe('reference data is public to read, admin-only to write', () => {
  test('a logged-out visitor can read ports, ships and goods', async () => {
    expect(await t.asAnon('select count(*)::int n from ports')).toEqual([{ n: 42 }]);
    expect(await t.asAnon('select count(*)::int n from ships')).toEqual([{ n: 38 }]);
    expect(await t.asAnon('select count(*)::int n from goods')).toEqual([{ n: 61 }]);
    expect(await t.asAnon('select count(*)::int n from upgrades')).toEqual([{ n: 20 }]);
  });

  test('an ordinary logged-in user cannot change a ship stat', async () => {
    // The admin-only policy matches no rows for Bob, and Postgres reports that
    // as zero rows changed rather than an error, so the check is that nothing
    // actually moved.
    const changed = await t.asUser(
      BOB,
      `update ships set hold = 999999 where id = 'friede' returning id`,
    );
    expect(changed).toHaveLength(0);

    const after = (await t.asAnon(`select hold from ships where id = 'friede'`)) as {
      hold: number;
    }[];
    expect(after[0]!.hold).toBe(11000); // the seeded value, untouched

    // An insert has nothing to filter, so it is refused outright.
    await expectRejected(
      t.asUser(BOB, `insert into ports (id, name, x, y) values ('fake', 'Fake', 1, 1)`),
    );
    expect(await t.asAnon('select count(*)::int n from ports')).toEqual([{ n: 42 }]);
  });

  test('an admin can', async () => {
    // A value nothing else uses, so this cannot pass by coincidence.
    const changed = await t.asUser(
      ADMIN,
      `update ships set hold = 12345 where id = 'friede' returning id`,
    );
    expect(changed).toHaveLength(1);

    const rows = (await t.asAnon(`select hold from ships where id = 'friede'`)) as {
      hold: number;
    }[];
    expect(rows[0]!.hold).toBe(12345);

    // Put it back so later tests see the real seeded stats.
    await t.asUser(ADMIN, `update ships set hold = 11000 where id = 'friede'`);
  });
});

describe('another user’s private data is unreachable', () => {
  test('Bob cannot read Alice’s ship presets', async () => {
    // This is the exact check SPEC.md 3.2 asks for.
    expect(await t.asUser(BOB, 'select * from ship_presets')).toHaveLength(0);
  });

  test('a logged-out visitor cannot read anyone’s ship presets', async () => {
    // Refused outright at the grant level rather than returning an empty set,
    // because the schema revokes anon's access to per-user tables entirely.
    await expectRejected(t.asAnon('select * from ship_presets'), /permission denied/);
  });

  test('Alice can read her own ship presets', async () => {
    expect(await t.asUser(ALICE, 'select * from ship_presets')).toHaveLength(1);
  });

  test('Bob cannot read or alter Alice’s saved routes', async () => {
    expect(await t.asUser(BOB, 'select * from saved_routes')).toHaveLength(0);
    await t.asUser(BOB, `update saved_routes set label = 'stolen'`);
    const alice = (await t.asUser(ALICE, 'select label from saved_routes')) as {
      label: string;
    }[];
    expect(alice[0]!.label).toBe('Alice route');
  });

  test('Bob cannot insert a preset owned by Alice', async () => {
    await expectRejected(
      t.asUser(
        BOB,
        `insert into ship_presets (profile_id, name, ship_id) values ('${ALICE}', 'forged', 'pickle')`,
      ),
    );
  });

  test('a profile is visible only to its owner', async () => {
    expect(await t.asUser(ALICE, 'select * from profiles')).toHaveLength(1);
    // Bob is logged in and has the grant, so RLS is what stops him: he sees
    // his own row and nobody else's.
    const bob = (await t.asUser(BOB, 'select id from profiles')) as { id: string }[];
    expect(bob.map((r) => r.id)).toEqual([BOB]);
    await expectRejected(t.asAnon('select * from profiles'), /permission denied/);
  });
});

describe('price submissions are shared but append-only', () => {
  test('anyone may read them, including logged-out visitors', async () => {
    await t.db.exec(`
      insert into price_submissions
        (server_id, port_id, good_id, buy_price, sell_price, submitted_by, source)
      values ('na', 'fiji', 'sugar', 400, 400, '${ALICE}', 'manual');
    `);
    expect(await t.asAnon('select count(*)::int n from price_submissions')).toEqual([{ n: 1 }]);
  });

  test('a logged-out visitor cannot submit a price', async () => {
    await expectRejected(
      t.asAnon(
        `insert into price_submissions (server_id, port_id, good_id, buy_price, source)
         values ('na', 'fiji', 'silk', 880, 'manual')`,
      ),
    );
  });

  test('a logged-in user may submit a price as themselves', async () => {
    await t.asUser(
      BOB,
      `insert into price_submissions (server_id, port_id, good_id, buy_price, sell_price, submitted_by, source)
       values ('na', 'st_john', 'silk', 530, 530, '${BOB}', 'manual')`,
    );
    expect(await t.asAnon('select count(*)::int n from price_submissions')).toEqual([{ n: 2 }]);
  });

  test('a user cannot submit a price under someone else’s name', async () => {
    await expectRejected(
      t.asUser(
        BOB,
        `insert into price_submissions (server_id, port_id, good_id, buy_price, submitted_by, source)
         values ('na', 'st_john', 'beer', 52, '${ALICE}', 'manual')`,
      ),
    );
  });

  test('a user cannot pass their own submission off as demo data', async () => {
    await expectRejected(
      t.asUser(
        BOB,
        `insert into price_submissions (server_id, port_id, good_id, buy_price, submitted_by, source, is_demo)
         values ('na', 'st_john', 'beer', 52, '${BOB}', 'demo', true)`,
      ),
    );
  });

  test('nobody can edit a submission, not even their own', async () => {
    // The update policy is admin-only, so for an ordinary user this matches no
    // rows at all. Postgres reports that as zero rows changed, not an error,
    // so the check has to be that nothing moved rather than that it threw.
    const changed = await t.asUser(
      BOB,
      `update price_submissions set buy_price = 1
        where submitted_by = '${BOB}' returning id`,
    );
    expect(changed).toHaveLength(0);

    const after = (await t.asAnon(
      `select buy_price from price_submissions where submitted_by = '${BOB}'`,
    )) as { buy_price: number }[];
    expect(after[0]!.buy_price).toBe(530);
  });

  test('nobody can delete a submission', async () => {
    await expectRejected(t.asUser(BOB, 'delete from price_submissions'));
    await expectRejected(t.asUser(ADMIN, 'delete from price_submissions'));
    expect(await t.asAnon('select count(*)::int n from price_submissions')).toEqual([{ n: 2 }]);
  });

  test('an admin may flag a submission', async () => {
    await t.asUser(
      ADMIN,
      `update price_submissions set flagged = true, flag_reason = 'outside sanity band'
        where good_id = 'silk'`,
    );
    const rows = (await t.asAnon(
      `select flagged from price_submissions where good_id = 'silk'`,
    )) as { flagged: boolean }[];
    expect(rows[0]!.flagged).toBe(true);
  });

  test('an admin flagging a row still cannot rewrite the price', async () => {
    // The policy lets admins update; the trigger keeps that to the flag
    // columns, so history cannot be quietly rewritten.
    await expectRejected(
      t.asUser(ADMIN, `update price_submissions set buy_price = 1 where good_id = 'silk'`),
      /append-only/,
    );
  });
});

describe('OCR corrections are write-only for ordinary users', () => {
  test('a logged-in user may record a correction', async () => {
    await t.asUser(
      BOB,
      `insert into ocr_corrections (screen_type, field_name, ocr_value, corrected_value)
       values ('market', 'sugar', '4O.O', '40.0')`,
    );
  });

  test('but cannot read the corrections back', async () => {
    // Bob has the grant, so it is the policy that empties his result.
    expect(await t.asUser(BOB, 'select * from ocr_corrections')).toHaveLength(0);
    // A logged-out visitor has no grant at all, so it is refused earlier.
    await expectRejected(t.asAnon('select * from ocr_corrections'), /permission denied/);
  });

  test('an admin can read them', async () => {
    expect(await t.asUser(ADMIN, 'select * from ocr_corrections')).toHaveLength(1);
  });
});

describe('the admin list itself is unreachable through the API', () => {
  test('nobody can read who the admins are', async () => {
    await expectRejected(t.asAnon('select * from admins'));
    await expectRejected(t.asUser(BOB, 'select * from admins'));
  });

  test('nobody can make themselves an admin', async () => {
    await expectRejected(t.asUser(BOB, `insert into admins (user_id) values ('${BOB}')`));
  });
});

describe('every table has row-level security switched on', () => {
  test('no table in the public schema is left unprotected', async () => {
    const rows = (await t.db.query(`
      select c.relname
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
       order by 1
    `)) as { rows: { relname: string }[] };
    expect(rows.rows.map((r) => r.relname)).toEqual([]);
  });
});
