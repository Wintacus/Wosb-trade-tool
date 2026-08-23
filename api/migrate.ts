import { timingSafeEqual, createHash } from 'node:crypto';
import { Client } from 'pg';
import { schemaSql, seedSql, demoPricesSql } from './_sql';

/**
 * One-tap database setup.
 *
 * Applies supabase/schema.sql, seed.sql and optionally demo_prices.sql, then
 * verifies the result and reports it as JSON. Safe to run repeatedly: the
 * schema creates objects only if absent, the seed upserts, and the demo data
 * replaces only rows already flagged as demo.
 *
 * SERVER ONLY. This reads DATABASE_URL and ADMIN_TOKEN, neither of which
 * carries the VITE_ prefix, so neither can reach the browser bundle.
 *
 *   GET /api/migrate?token=...            schema + seed + demo data
 *   GET /api/migrate?token=...&demo=0     schema + seed only
 *   GET /api/migrate?token=...&verify=1   check only, change nothing
 */

interface VercelRequest {
  method?: string;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
}

interface VercelResponse {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
}

/** Row counts SPEC.md 3.3 requires after seeding. */
const EXPECTED: { label: string; sql: string; expected: number }[] = [
  { label: 'ports', sql: 'select count(*)::int n from ports', expected: 42 },
  { label: 'ships', sql: 'select count(*)::int n from ships', expected: 38 },
  { label: 'goods (total)', sql: 'select count(*)::int n from goods', expected: 61 },
  {
    label: 'goods (trade goods)',
    sql: 'select count(*)::int n from goods where is_trade_good',
    expected: 20,
  },
  {
    label: 'goods (craft + special)',
    sql: 'select count(*)::int n from goods where not is_trade_good',
    expected: 41,
  },
  { label: 'upgrades', sql: 'select count(*)::int n from upgrades', expected: 20 },
  { label: 'servers', sql: 'select count(*)::int n from servers', expected: 4 },
];

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Constant-time compare, so the token cannot be guessed a character at a time. */
function tokenMatches(supplied: string, expected: string): boolean {
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');

  const adminToken = process.env.ADMIN_TOKEN;
  const databaseUrl = process.env.DATABASE_URL;

  if (!adminToken) {
    res.status(500).json({
      ok: false,
      error: 'ADMIN_TOKEN is not set in this deployment.',
      fix: 'Add ADMIN_TOKEN in Vercel under Settings, Environment Variables, then redeploy.',
    });
    return;
  }
  if (!databaseUrl) {
    res.status(500).json({
      ok: false,
      error: 'DATABASE_URL is not set in this deployment.',
      fix:
        'Copy the URI connection string from Supabase, Settings, Database, and add it in ' +
        'Vercel under Settings, Environment Variables, then redeploy.',
    });
    return;
  }

  const supplied = first(req.query.token) ?? first(req.headers['x-admin-token']) ?? '';
  if (!supplied || !tokenMatches(supplied, adminToken)) {
    // Deliberately vague: a precise message helps an attacker, nobody else.
    res.status(401).json({ ok: false, error: 'Unauthorised.' });
    return;
  }

  const withDemo = first(req.query.demo) !== '0';
  const verifyOnly = first(req.query.verify) === '1';

  const client = new Client({
    connectionString: databaseUrl,
    // Supabase terminates TLS at the pooler with a certificate chain Node does
    // not ship a root for. The connection is still encrypted.
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
    statement_timeout: 120_000,
  });

  const steps: { step: string; ok: boolean; detail: string }[] = [];

  try {
    await client.connect();
    steps.push({ step: 'connect', ok: true, detail: 'Connected to Postgres.' });
  } catch (error) {
    res.status(502).json({
      ok: false,
      steps,
      error: `Could not connect: ${error instanceof Error ? error.message : String(error)}`,
      fix: 'Check DATABASE_URL. Use the URI form, and the session pooler host if available.',
    });
    return;
  }

  try {
    if (!verifyOnly) {
      // Each file runs as a single multi-statement query, which keeps dollar
      // quoted function bodies and DO blocks intact. Splitting on semicolons
      // would tear them apart.
      const files: [string, string][] = [
        ['schema.sql', schemaSql],
        ['seed.sql', seedSql],
      ];
      if (withDemo) files.push(['demo_prices.sql', demoPricesSql]);

      for (const [name, sql] of files) {
        const startedAt = Date.now();
        await client.query(sql);
        steps.push({
          step: name,
          ok: true,
          detail: `Applied in ${Date.now() - startedAt}ms.`,
        });
      }
    }

    // --- Verify -----------------------------------------------------------
    const counts: Record<string, { found: number; expected: number; ok: boolean }> = {};
    let countsOk = true;
    for (const { label, sql, expected } of EXPECTED) {
      const found = (await client.query(sql)).rows[0].n as number;
      const ok = found === expected;
      if (!ok) countsOk = false;
      counts[label] = { found, expected, ok };
    }
    steps.push({
      step: 'row counts',
      ok: countsOk,
      detail: countsOk ? 'All match SPEC.md 3.3.' : 'One or more counts are wrong.',
    });

    const unprotected = (
      await client.query(`
        select c.relname
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
         order by 1
      `)
    ).rows.map((r: { relname: string }) => r.relname);

    steps.push({
      step: 'row-level security',
      ok: unprotected.length === 0,
      detail:
        unprotected.length === 0
          ? 'Enabled on every table.'
          : `MISSING on: ${unprotected.join(', ')}`,
    });

    const policies = (await client.query(`select count(*)::int n from pg_policies where schemaname = 'public'`))
      .rows[0].n as number;

    const prices = (await client.query('select count(*)::int n from prices_current')).rows[0]
      .n as number;
    const portState = (await client.query('select count(*)::int n from port_state_current'))
      .rows[0].n as number;

    const ok = steps.every((s) => s.ok);
    res.status(ok ? 200 : 500).json({
      ok,
      mode: verifyOnly ? 'verify only, nothing changed' : withDemo ? 'schema + seed + demo' : 'schema + seed',
      steps,
      counts,
      policies,
      pricesAvailable: prices,
      portStateAvailable: portState,
      message: ok
        ? 'Database is set up. Open the site to see the live checks.'
        : 'Something is wrong. See steps and counts above.',
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      steps,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}
