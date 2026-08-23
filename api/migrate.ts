import { Client } from 'pg';
import { schemaSql, seedSql, demoPricesSql } from './_sql';
import { setupPage, resultPage } from './_page';

/**
 * One-page database setup.
 *
 * GET  /api/migrate   serves a form asking for the database password
 * POST /api/migrate   applies schema, seed and demo data, then verifies
 *
 * Deliberately needs NO configuration. The Supabase project reference is read
 * out of VITE_SUPABASE_URL, which is already set, and the connection string is
 * built from it. The only thing that cannot be derived is the database
 * password, so that is the only thing the form asks for.
 *
 * The password is used to open one connection and is never stored, logged or
 * written anywhere. It arrives in a POST body rather than a query string
 * specifically so it cannot end up in browser history or a URL log.
 *
 * SERVER ONLY. Nothing here reaches the browser bundle: a test fails if
 * anything under src/ imports this directory.
 */

export const config = { maxDuration: 60 };

interface Req {
  method?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

interface Res {
  status: (code: number) => Res;
  send: (body: string) => void;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
}

/** Row counts SPEC.md 3.3 requires after seeding. */
const EXPECTED: { label: string; sql: string; expected: number }[] = [
  { label: 'Ports', sql: 'select count(*)::int n from ports', expected: 42 },
  { label: 'Ships', sql: 'select count(*)::int n from ships', expected: 38 },
  { label: 'Goods (total)', sql: 'select count(*)::int n from goods', expected: 61 },
  {
    label: 'Goods (trade goods)',
    sql: 'select count(*)::int n from goods where is_trade_good',
    expected: 20,
  },
  {
    label: 'Goods (craft + special)',
    sql: 'select count(*)::int n from goods where not is_trade_good',
    expected: 41,
  },
  { label: 'Upgrades', sql: 'select count(*)::int n from upgrades', expected: 20 },
  { label: 'Servers', sql: 'select count(*)::int n from servers', expected: 4 },
];

/**
 * Regions Supabase runs its connection pooler in.
 *
 * The pooler hostname embeds the region and nothing in the project URL reveals
 * which one it is, so the only way to find out without asking is to try. Each
 * attempt is given a short timeout and they run in sequence, cheapest first.
 */
const POOLER_REGIONS = [
  'us-east-1',
  'us-west-1',
  'eu-central-1',
  'eu-west-1',
  'eu-west-2',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-south-1',
  'sa-east-1',
  'ca-central-1',
  'us-west-2',
  'eu-central-2',
];

/** Pull the project reference out of https://abcdefgh.supabase.co */
export function projectRef(): string | null {
  const url = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
  if (!url) return null;
  const match = /https?:\/\/([a-z0-9]+)\.supabase\./i.exec(url.trim());
  return match ? match[1]! : null;
}

export function candidateConnections(ref: string, password: string): { label: string; url: string }[] {
  const encoded = encodeURIComponent(password);
  return [
    // Direct connection. Fastest when it is reachable, but Supabase now serves
    // it over IPv6 only for most projects, which many serverless hosts cannot
    // reach -- hence the pooler fallbacks below.
    {
      label: 'direct',
      url: `postgresql://postgres:${encoded}@db.${ref}.supabase.co:5432/postgres`,
    },
    ...POOLER_REGIONS.map((region) => ({
      label: `pooler ${region}`,
      url: `postgresql://postgres.${ref}:${encoded}@aws-0-${region}.pooler.supabase.com:5432/postgres`,
    })),
  ];
}

interface Attempt {
  label: string;
  error: string;
}

/** True when the server answered but rejected us, so trying elsewhere is pointless. */
export function isAuthFailure(message: string): boolean {
  return /password authentication failed|role .* does not exist|Tenant or user not found/i.test(
    message,
  );
}

async function connect(
  ref: string,
  password: string,
): Promise<{ client: Client; via: string } | { error: string; attempts: Attempt[] }> {
  const attempts: Attempt[] = [];

  for (const candidate of candidateConnections(ref, password)) {
    const client = new Client({
      connectionString: candidate.url,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 4000,
      statement_timeout: 120_000,
    });
    try {
      await client.connect();
      return { client, via: candidate.label };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await client.end().catch(() => undefined);
      attempts.push({ label: candidate.label, error: message });

      // A wrong password is a wrong password everywhere. Stop rather than
      // hammering fourteen hosts with bad credentials.
      if (isAuthFailure(message)) {
        return {
          error:
            'The database password was not accepted. Reset it in Supabase (link below) ' +
            'and paste the new one.',
          attempts,
        };
      }
    }
  }

  return {
    error:
      'Could not reach the database on any known host. If your project is in an unusual ' +
      'region, paste the full connection string into the advanced box instead.',
    attempts,
  };
}

export default async function handler(req: Req, res: Res): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  // The password is typed here; keep it out of any referrer sent onward.
  res.setHeader('Referrer-Policy', 'no-referrer');

  const ref = projectRef();

  if (req.method !== 'POST') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(setupPage(ref));
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const password = typeof body.password === 'string' ? body.password.trim() : '';
  const override = typeof body.connectionString === 'string' ? body.connectionString.trim() : '';
  const withDemo = body.demo !== false && body.demo !== 'false';

  if (!password && !override) {
    res.status(400).json({ ok: false, error: 'No password supplied.' });
    return;
  }
  if (!ref && !override) {
    res.status(500).json({
      ok: false,
      error:
        'VITE_SUPABASE_URL is not set in this deployment, so the project cannot be identified. ' +
        'Paste a full connection string instead.',
    });
    return;
  }

  // --- Connect ------------------------------------------------------------
  let client: Client;
  let via: string;

  if (override) {
    client = new Client({
      connectionString: override,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000,
      statement_timeout: 120_000,
    });
    try {
      await client.connect();
      via = 'supplied connection string';
    } catch (error) {
      res.status(502).json({
        ok: false,
        error: `Could not connect: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
  } else {
    const result = await connect(ref!, password);
    if ('error' in result) {
      res.status(502).json({ ok: false, error: result.error, attempts: result.attempts });
      return;
    }
    client = result.client;
    via = result.via;
  }

  // --- Apply and verify ---------------------------------------------------
  const steps: { step: string; ok: boolean; detail: string }[] = [
    { step: 'Connect', ok: true, detail: `Connected via ${via}.` },
  ];

  try {
    // Each file runs as ONE multi-statement query, so dollar-quoted function
    // bodies and DO blocks stay intact. Splitting on semicolons would tear
    // them apart.
    const files: [string, string][] = [
      ['Schema and security', schemaSql],
      ['Reference data', seedSql],
    ];
    if (withDemo) files.push(['Demo prices', demoPricesSql]);

    for (const [label, sql] of files) {
      const startedAt = Date.now();
      await client.query(sql);
      steps.push({ step: label, ok: true, detail: `Applied in ${Date.now() - startedAt}ms.` });
    }

    const counts: { label: string; found: number; expected: number; ok: boolean }[] = [];
    let countsOk = true;
    for (const { label, sql, expected } of EXPECTED) {
      const found = (await client.query(sql)).rows[0].n as number;
      const ok = found === expected;
      if (!ok) countsOk = false;
      counts.push({ label, found, expected, ok });
    }
    steps.push({
      step: 'Row counts',
      ok: countsOk,
      detail: countsOk ? 'All match the specification.' : 'One or more counts are wrong.',
    });

    const unprotected = (
      await client.query(`
        select c.relname from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
         order by 1
      `)
    ).rows.map((r: { relname: string }) => r.relname);

    steps.push({
      step: 'Row-level security',
      ok: unprotected.length === 0,
      detail:
        unprotected.length === 0
          ? 'Enabled on every table.'
          : `MISSING on: ${unprotected.join(', ')}`,
    });

    const prices = (await client.query('select count(*)::int n from prices_current')).rows[0]
      .n as number;
    const portState = (await client.query('select count(*)::int n from port_state_current'))
      .rows[0].n as number;

    const ok = steps.every((s) => s.ok);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(resultPage({ ok, steps, counts, prices, portState }));
  } catch (error) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(
      resultPage({
        ok: false,
        steps: [
          ...steps,
          {
            step: 'Failed',
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          },
        ],
        counts: [],
        prices: 0,
        portState: 0,
      }),
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}
