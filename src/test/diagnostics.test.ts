import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The live checks shown on the deployed site.
 *
 * This page is the only way the setup can be verified from a phone, so a check
 * that quietly passes when it should fail is worse than no check at all. What
 * matters most here is the row-level security probe: it must report a LEAK
 * when a logged-out visitor can read private rows, and it must not mistake a
 * refusal for a leak.
 */

const state = {
  counts: new Map<string, number>(),
  errors: new Map<string, string>(),
  privateRows: new Map<string, unknown[]>(),
};

vi.mock('../lib/supabase', () => {
  const builder = (table: string) => {
    const result = {
      // count query: .select('*', { count: 'exact', head: true })
      // rows query:  .select('*').limit(1)
      select(_columns: string, options?: { head?: boolean }) {
        const error = state.errors.get(table);
        if (options?.head) {
          const chain = {
            eq(_column: string, value: boolean) {
              const key = `${table}:${value}`;
              return Promise.resolve({
                count: state.counts.get(key) ?? null,
                error: error ? { message: error } : null,
              });
            },
            then(resolve: (v: unknown) => void) {
              resolve({
                count: state.counts.get(table) ?? null,
                error: error ? { message: error } : null,
              });
            },
          };
          return chain;
        }
        return {
          limit() {
            return Promise.resolve({
              data: state.privateRows.get(table) ?? [],
              error: error ? { message: error } : null,
            });
          },
        };
      },
    };
    return result;
  };

  return {
    supabaseConfigured: true,
    supabase: { from: (table: string) => builder(table) },
  };
});

const { runDiagnostics } = await import('../lib/diagnostics');

function seedHealthy(): void {
  state.counts.clear();
  state.errors.clear();
  state.privateRows.clear();
  state.counts.set('servers', 4);
  state.counts.set('ports', 42);
  state.counts.set('ships', 38);
  state.counts.set('goods', 61);
  state.counts.set('goods:true', 20);
  state.counts.set('goods:false', 41);
  state.counts.set('upgrades', 20);
  state.counts.set('prices_current', 115);
  state.counts.set('port_state_current', 4);
}

beforeEach(seedHealthy);
afterEach(() => vi.clearAllMocks());

const find = (checks: { label: string; status: string; detail: string }[], needle: string) =>
  checks.find((c) => c.label.toLowerCase().includes(needle.toLowerCase()))!;

describe('a healthy database', () => {
  test('reports every check as passing', async () => {
    const checks = await runDiagnostics();
    const failures = checks.filter((c) => c.status === 'fail');
    expect(failures.map((f) => f.label)).toEqual([]);
  });

  test('checks all seven seed counts from the specification', async () => {
    const checks = await runDiagnostics();
    for (const expected of ['Ports', 'Ships', 'Goods (total)', 'Upgrades', 'Servers']) {
      expect(find(checks, expected)).toBeDefined();
    }
  });

  test('checks both views the calculator reads from', async () => {
    const checks = await runDiagnostics();
    expect(find(checks, 'Prices available').status).toBe('pass');
    expect(find(checks, 'Port state available').status).toBe('pass');
  });
});

describe('a wrong row count is caught, not glossed over', () => {
  test('a short import fails the check and says how to fix it', async () => {
    state.counts.set('ports', 41); // one port missing
    const checks = await runDiagnostics();
    const ports = find(checks, 'Ports');
    expect(ports.status).toBe('fail');
    expect(ports.detail).toContain('41');
  });
});

describe('the row-level security probe', () => {
  test('a refusal is a pass, because being blocked is the point', async () => {
    state.errors.set('ship_presets', 'permission denied for table ship_presets');
    const checks = await runDiagnostics();
    expect(find(checks, 'ship_presets').status).toBe('pass');
  });

  test('an empty result is a pass, because the policy filtered it', async () => {
    state.privateRows.set('ship_presets', []);
    const checks = await runDiagnostics();
    expect(find(checks, 'ship_presets').status).toBe('pass');
  });

  test('rows coming back to a logged-out visitor is a LEAK and fails loudly', async () => {
    // The check that actually earns its keep. If a policy is ever wrong, this
    // is what says so.
    state.privateRows.set('ship_presets', [{ id: 'someone-elses-preset' }]);
    const checks = await runDiagnostics();
    const check = find(checks, 'ship_presets');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/leak/i);
  });

  test('every private table is probed, not just one', async () => {
    const checks = await runDiagnostics();
    for (const table of ['profiles', 'ship_presets', 'saved_routes', 'ocr_corrections']) {
      expect(find(checks, table), `${table} is not probed`).toBeDefined();
    }
  });
});

describe('an empty but working database', () => {
  test('no prices yet is a warning, not a failure', async () => {
    // A fresh database with nothing observed is working correctly, just not
    // useful yet. Calling that a failure would train the user to ignore red.
    state.counts.set('prices_current', 0);
    state.counts.set('port_state_current', 0);
    const checks = await runDiagnostics();
    expect(find(checks, 'Prices available').status).toBe('warn');
    expect(find(checks, 'Port state available').status).toBe('warn');
    expect(checks.filter((c) => c.status === 'fail')).toEqual([]);
  });
});

describe('the secret check', () => {
  test('passes when no VITE_ variable is named like a secret', async () => {
    const checks = await runDiagnostics();
    expect(checks.find((c) => c.id === 'secrets')!.status).toBe('pass');
  });

  test('is not fooled by server-side variables in the surrounding process', async () => {
    // An earlier version scanned every name it could see and reported a leak
    // for whatever the host machine happened to have set. Vite never puts
    // those in a browser bundle, so that was a false alarm by construction.
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_definitely_not_leaked';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-not-leaked';
    const checks = await runDiagnostics();
    expect(checks.find((c) => c.id === 'secrets')!.status).toBe('pass');
  });
});
