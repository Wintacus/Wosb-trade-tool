import { describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './pg';

/**
 * The build step that applies schema changes on every deployment.
 *
 * The rules it follows are api/_auto.ts, which is tested against a real
 * Postgres elsewhere. What is only true here is the wiring: that the script
 * bundles and imports that module successfully under real Node, that it stays
 * quiet when there is nothing to talk to, and that a database problem does not
 * take a deployment down with it.
 *
 * The bundling matters more than it looks. A module that cannot load is
 * exactly how the serverless function broke in production once already, with
 * every test still green.
 */

function runScript(env: Record<string, string | undefined>): { out: string; code: number } {
  // spawnSync rather than execFileSync: the script reports failures on stderr,
  // and execFileSync hands back only stdout when the process exits 0 -- which
  // this one deliberately does. That would have hidden exactly the messages
  // these tests are checking for.
  const result = spawnSync('node', ['scripts/apply-migrations.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ...env },
  });
  return {
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    code: result.status ?? 1,
  };
}

describe('with nothing to talk to', () => {
  test('it says so and succeeds, so a local build is not noisy or broken', () => {
    const { out, code } = runScript({
      SUPABASE_SERVICE_ROLE_KEY: undefined,
      VITE_SUPABASE_URL: undefined,
    });
    expect(code).toBe(0);
    expect(out).toMatch(/No Supabase credentials/i);
  });

  test('the URL alone is not enough to try', () => {
    const { out, code } = runScript({
      VITE_SUPABASE_URL: 'https://testref.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: undefined,
    });
    expect(code).toBe(0);
    expect(out).toMatch(/No Supabase credentials/i);
  });
});

describe('when the database cannot be reached', () => {
  // Port 1 refuses connections immediately, so this is fast and deterministic.
  const unreachable = {
    VITE_SUPABASE_URL: 'http://127.0.0.1:1',
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
  };

  test('the module bundles and loads, reaching the point of trying', () => {
    // If esbuild or the import failed, the message would be about that rather
    // than about the connection.
    const { out } = runScript(unreachable);
    expect(out).toMatch(/\[migrate\]/);
    expect(out).not.toMatch(/Could not run schema changes/i);
  });

  test('it reports the failure loudly', () => {
    const { out } = runScript(unreachable);
    expect(out).toMatch(/did NOT apply|FAIL/i);
  });

  test('but does NOT fail the build', () => {
    // Someone who can only work from a phone should not have deployments
    // blocked by a transient database problem. The site reports the drift.
    const { code } = runScript(unreachable);
    expect(code).toBe(0);
  });

  test('and points at the way to retry', () => {
    const { out } = runScript(unreachable);
    expect(out).toMatch(/api\/migrate\?auto=1/);
  });
});

describe('it is wired into the build', () => {
  test('the build script runs it after the app is built', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string | undefined>;
    };
    const buildScript = pkg.scripts.build ?? '';
    expect(buildScript).toContain('apply-migrations.mjs');
    // After vite build, so a database problem never leaves a half-built site.
    expect(buildScript.indexOf('vite build')).toBeLessThan(
      buildScript.indexOf('apply-migrations.mjs'),
    );
  });
});
