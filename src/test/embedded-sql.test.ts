import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { schemaSql, seedSql, demoPricesSql } from '../../api/_sql';
import { readSql, repoRoot } from './pg';

/**
 * The SQL embedded in the serverless migrate endpoint.
 *
 * The endpoint carries the SQL in its own bundle rather than reading files at
 * runtime, because a serverless function is not guaranteed the repository's
 * files on disk. That embedding goes through template-literal escaping, so it
 * has to be proved intact rather than assumed: a single mangled backslash or
 * backtick would produce SQL that fails only once it hits the real database,
 * which is exactly where a failure is most expensive.
 */

describe('the embedded SQL is byte-identical to the files', () => {
  const cases: [string, string][] = [
    ['schema.sql', schemaSql],
    ['seed.sql', seedSql],
    ['demo_prices.sql', demoPricesSql],
  ];

  for (const [name, embedded] of cases) {
    test(`${name} survives embedding unchanged`, () => {
      expect(embedded).toBe(readSql(name));
    });
  }

  test('api/_sql.ts is up to date with its generator', () => {
    const path = join(repoRoot, 'api', '_sql.ts');
    const before = readFileSync(path, 'utf8');
    execFileSync('node', ['scripts/gen-embedded-sql.mjs'], { cwd: repoRoot });
    const after = readFileSync(path, 'utf8');
    writeFileSync(path, before, 'utf8'); // leave the tree as found
    expect(after, 'api/_sql.ts is stale. Run: npm run gen:sql').toBe(before);
  });
});

describe('the embedded SQL actually runs', () => {
  test('applies cleanly against a real Postgres, exactly as the endpoint does', async () => {
    // The endpoint runs each file as ONE multi-statement query so that dollar
    // quoted function bodies and DO blocks stay intact. This reproduces that
    // precisely, rather than splitting on semicolons the way a naive runner
    // would.
    const db = new PGlite();
    await db.exec(`
      create schema if not exists auth;
      create table if not exists auth.users (id uuid primary key, email text);
      create or replace function auth.uid() returns uuid
        language sql stable as $fn$
          select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
        $fn$;
      do $roles$
      begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then
          create role anon nologin;
        end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then
          create role authenticated nologin;
        end if;
      end $roles$;
    `);

    await db.exec(schemaSql);
    await db.exec(seedSql);
    await db.exec(demoPricesSql);

    // The same checks the endpoint reports back.
    const counts = await db.query<{ n: number }>(`
      select
        (select count(*)::int from ports) as ports,
        (select count(*)::int from ships) as ships,
        (select count(*)::int from goods) as goods,
        (select count(*)::int from upgrades) as upgrades,
        (select count(*)::int from servers) as servers
    `);
    expect(counts.rows[0]).toEqual({
      ports: 42,
      ships: 38,
      goods: 61,
      upgrades: 20,
      servers: 4,
    });

    const unprotected = await db.query<{ relname: string }>(`
      select c.relname from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
    `);
    expect(unprotected.rows).toEqual([]);

    const views = await db.query<{ n: number }>(
      `select count(*)::int n from pg_views where schemaname = 'public'`,
    );
    expect(views.rows[0]!.n).toBe(2); // prices_current, port_state_current

    await db.close();
  }, 120_000);

  test('re-running everything is harmless, because the endpoint can be tapped twice', async () => {
    const db = new PGlite();
    await db.exec(`
      create schema if not exists auth;
      create table if not exists auth.users (id uuid primary key, email text);
      create or replace function auth.uid() returns uuid
        language sql stable as $fn$ select null::uuid; $fn$;
      do $roles$
      begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then
          create role anon nologin;
        end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then
          create role authenticated nologin;
        end if;
      end $roles$;
    `);

    for (let pass = 0; pass < 2; pass++) {
      await db.exec(schemaSql);
      await db.exec(seedSql);
      await db.exec(demoPricesSql);
    }

    // Nothing duplicated: seeds upsert, and demo rows are replaced not appended.
    const after = await db.query<{ n: number }>(`
      select
        (select count(*)::int from ports) as ports,
        (select count(*)::int from goods) as goods,
        (select count(*)::int from price_submissions) as prices,
        (select count(*)::int from port_state_submissions) as port_state
    `);
    expect(after.rows[0]).toEqual({ ports: 42, goods: 61, prices: 115, port_state: 4 });

    await db.close();
  }, 120_000);
});
