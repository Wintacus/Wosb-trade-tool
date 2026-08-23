import { supabase, supabaseConfigured } from './supabase';

/**
 * Live checks for the Phase 1 "Done when" criteria.
 *
 * These run in the browser with the publishable key, which is the point: they
 * verify what an ordinary visitor can actually reach, at the deployed URL,
 * rather than what a privileged connection can do.
 */

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'pending';

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

/** Row counts required by SPEC.md 3.3. */
const EXPECTED_COUNTS: { table: string; label: string; expected: number; filter?: string }[] = [
  { table: 'ports', label: 'Ports', expected: 42 },
  { table: 'ships', label: 'Ships', expected: 38 },
  { table: 'goods', label: 'Goods (total)', expected: 61 },
  { table: 'goods', label: 'Goods (trade goods)', expected: 20, filter: 'is_trade_good=eq.true' },
  { table: 'goods', label: 'Goods (craft + special)', expected: 41, filter: 'is_trade_good=eq.false' },
  { table: 'upgrades', label: 'Upgrades', expected: 20 },
  { table: 'servers', label: 'Servers', expected: 4 },
];

/** Tables an anonymous visitor must NOT be able to read rows out of. */
const PRIVATE_TABLES = ['profiles', 'ship_presets', 'saved_routes', 'ocr_corrections'];

async function countRows(
  table: string,
  filter?: string,
): Promise<{ count: number | null; error: string | null }> {
  if (!supabase) return { count: null, error: 'No Supabase client' };
  let query = supabase.from(table).select('*', { count: 'exact', head: true });
  if (filter) {
    const [column, rest] = filter.split('=eq.');
    query = query.eq(column!, rest === 'true');
  }
  const { count, error } = await query;
  return { count: count ?? null, error: error ? error.message : null };
}

/**
 * Confirms no server-only secret was bundled into the browser.
 *
 * A key without the VITE_ prefix should be invisible here. If one shows up,
 * it has leaked to every visitor and must be rotated, not just deleted --
 * removing the line does not remove it from git history.
 */
function checkNoSecretsInBundle(): Check {
  const env = import.meta.env as Record<string, unknown>;
  const leaked = Object.keys(env).filter((key) =>
    /SERVICE_ROLE|ANTHROPIC|SECRET|PASSWORD/i.test(key),
  );

  return leaked.length === 0
    ? {
        id: 'secrets',
        label: 'No server-only keys in the browser bundle',
        status: 'pass',
        detail: 'Only the two VITE_ variables are present, which is correct.',
      }
    : {
        id: 'secrets',
        label: 'No server-only keys in the browser bundle',
        status: 'fail',
        detail:
          `LEAKED: ${leaked.join(', ')}. Remove the VITE_ prefix in Vercel and ` +
          'ROTATE the key — deleting it does not remove it from git history.',
      };
}

export async function runDiagnostics(): Promise<Check[]> {
  const checks: Check[] = [checkNoSecretsInBundle()];

  if (!supabaseConfigured) {
    checks.push({
      id: 'config',
      label: 'Supabase connection',
      status: 'fail',
      detail:
        'VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY is missing. Add both in ' +
        'Vercel under Settings, Environment Variables, then redeploy: variables ' +
        'only apply to new deployments.',
    });
    return checks;
  }

  // --- Connection -------------------------------------------------------
  const probe = await countRows('servers');
  if (probe.error) {
    checks.push({
      id: 'config',
      label: 'Supabase connection',
      status: 'fail',
      detail:
        `Could not reach the database: ${probe.error}. If the tables do not ` +
        'exist yet, run supabase/schema.sql then supabase/seed.sql in the ' +
        'Supabase SQL Editor.',
    });
    return checks;
  }

  checks.push({
    id: 'config',
    label: 'Supabase connection',
    status: 'pass',
    detail: 'Connected with the publishable key.',
  });

  // --- Seed counts ------------------------------------------------------
  for (const { table, label, expected, filter } of EXPECTED_COUNTS) {
    const { count, error } = await countRows(table, filter);
    if (error) {
      checks.push({
        id: `count-${label}`,
        label: `${label}: expected ${expected}`,
        status: 'fail',
        detail: error,
      });
      continue;
    }
    checks.push({
      id: `count-${label}`,
      label: `${label}: expected ${expected}`,
      status: count === expected ? 'pass' : 'fail',
      detail:
        count === expected
          ? `Found ${count}.`
          : `Found ${count}. Re-run supabase/seed.sql — it asserts these counts itself.`,
    });
  }

  // --- Row-level security ----------------------------------------------
  // Either outcome is a pass: refused outright, or allowed through but
  // returning no rows. What must never happen is another user's data arriving.
  for (const table of PRIVATE_TABLES) {
    const { data, error } = await supabase!.from(table).select('*').limit(1);
    if (error) {
      checks.push({
        id: `rls-${table}`,
        label: `Row-level security: ${table}`,
        status: 'pass',
        detail: `Blocked without a login (${error.message}).`,
      });
      continue;
    }
    const rows = data?.length ?? 0;
    checks.push({
      id: `rls-${table}`,
      label: `Row-level security: ${table}`,
      status: rows === 0 ? 'pass' : 'fail',
      detail:
        rows === 0
          ? 'Returns no rows without a login, as it should.'
          : `LEAK: returned ${rows} row(s) to a logged-out visitor. The policy is wrong.`,
    });
  }

  // --- Prices -----------------------------------------------------------
  const prices = await countRows('prices_current');
  if (prices.error) {
    checks.push({
      id: 'prices',
      label: 'prices_current view',
      status: 'fail',
      detail: prices.error,
    });
  } else {
    checks.push({
      id: 'prices',
      label: 'prices_current view',
      status: (prices.count ?? 0) > 0 ? 'pass' : 'warn',
      detail:
        (prices.count ?? 0) > 0
          ? `${prices.count} price rows available.`
          : 'Readable, but empty. Run supabase/demo_prices.sql, or add real prices.',
    });
  }

  return checks;
}
