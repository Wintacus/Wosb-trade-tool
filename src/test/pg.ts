import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..', '..');

export function readSql(name: string): string {
  return readFileSync(join(repoRoot, 'supabase', name), 'utf8');
}

/**
 * Stubs for the parts of Supabase that live outside our schema file.
 *
 * Supabase provides an `auth` schema, an `auth.uid()` function and the `anon`
 * and `authenticated` roles. PGlite is plain Postgres, so the tests recreate
 * just enough of that for schema.sql to run unmodified. Running the real file
 * rather than a copy is the point: it means these tests fail if the SQL the
 * user actually pastes into Supabase is broken.
 */
const SUPABASE_STUBS = `
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text
);

-- Supabase reads the current user from a request-scoped setting. The stub does
-- the same, so policies can be exercised by setting request.jwt.claim.sub.
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
`;

export interface TestDb {
  db: PGlite;
  /** Run as an ordinary logged-in user, with RLS enforced. */
  asUser: (userId: string, sql: string, params?: unknown[]) => Promise<unknown[]>;
  /** Run as a logged-out visitor with the public key, with RLS enforced. */
  asAnon: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  close: () => Promise<void>;
}

/** Boot an in-process Postgres with the real schema.sql applied. */
export async function createTestDb(options: { seed?: boolean } = {}): Promise<TestDb> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  await db.exec(readSql('schema.sql'));
  if (options.seed) {
    await db.exec(readSql('seed.sql'));
  }

  const runAs = async (role: string, userId: string | null, sql: string, params?: unknown[]) => {
    await db.exec('begin');
    try {
      await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
      await db.exec(`set local role ${role}`);
      const result = await db.query(sql, params as never[]);
      await db.exec('commit');
      return result.rows as unknown[];
    } catch (error) {
      await db.exec('rollback');
      throw error;
    }
  };

  return {
    db,
    asUser: (userId, sql, params) => runAs('authenticated', userId, sql, params),
    asAnon: (sql, params) => runAs('anon', null, sql, params),
    close: () => db.close(),
  };
}
