import { afterAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './pg';

/**
 * Proves the serverless function can actually load and run under real Node ESM.
 *
 * This exists because of a failure the other 178 tests all missed. Every unit
 * test imported api/migrate through Vitest, which resolves extensionless
 * relative imports happily. Node does not. Deployed, the function died on load
 * with ERR_MODULE_NOT_FOUND and Vercel showed nothing but
 * FUNCTION_INVOCATION_FAILED -- a blank wall for the user.
 *
 * Passing tests are worth nothing if they exercise a resolver the production
 * runtime does not use. So this transpiles api/ the way Vercel does and runs it
 * in a real `node` process with no bundler, no loader and no test framework in
 * the way.
 */

const OUT = join(repoRoot, '.apitest');

/**
 * Every TypeScript file in api/, discovered rather than listed.
 *
 * A hand-maintained list silently stops covering the newest endpoint, which is
 * exactly the one most likely to have the import mistake this file exists to
 * catch.
 */
function apiSources(): string[] {
  return readdirSync(join(repoRoot, 'api'))
    .filter((name) => name.endsWith('.ts'))
    .sort();
}

function buildAndRun(script: string): string {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  execFileSync(
    'npx',
    [
      'esbuild',
      ...apiSources().map((file) => `api/${file}`),
      `--outdir=${OUT}`,
      '--format=esm',
      '--platform=node',
      '--log-level=error',
    ],
    { cwd: repoRoot, stdio: 'pipe' },
  );

  // A separate real node process: no Vitest resolver, no import maps, nothing
  // that would paper over a resolution mistake.
  return execFileSync('node', ['--input-type=module', '-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

afterAll(() => {
  rmSync(OUT, { recursive: true, force: true });
});

describe('the deployed function survives real Node ESM', () => {
  test('loads without ERR_MODULE_NOT_FOUND', () => {
    const output = buildAndRun(`
      const m = await import('${OUT}/migrate.js');
      if (typeof m.default !== 'function') throw new Error('no handler exported');
      console.log('LOADED');
    `);
    expect(output).toContain('LOADED');
  }, 120_000);

  test('serves the setup form when invoked', () => {
    const output = buildAndRun(`
      process.env.VITE_SUPABASE_URL = 'https://testref123.supabase.co';
      const m = await import('${OUT}/migrate.js');
      let code = 0, body = '';
      const res = {
        status(c) { code = c; return res; },
        send(b) { body = b; },
        json(j) { body = JSON.stringify(j); },
        setHeader() {},
      };
      await m.default({ method: 'GET', headers: {} }, res);
      console.log(JSON.stringify({
        code,
        hasPasswordField: body.includes('type="password"'),
        detectsProject: body.includes('testref123'),
      }));
    `);
    const result = JSON.parse(output.trim().split('\n').pop()!);
    expect(result).toEqual({ code: 200, hasPasswordField: true, detectsProject: true });
  }, 120_000);

  test('a thrown error becomes a readable page, never a blank crash', () => {
    // The user should never see FUNCTION_INVOCATION_FAILED again. Forcing the
    // handler to throw proves the top-level catch turns it into something that
    // at least names the problem.
    const output = buildAndRun(`
      process.env.VITE_SUPABASE_URL = 'https://testref123.supabase.co';
      const m = await import('${OUT}/migrate.js');
      let code = 0, body = '';
      const res = {
        status(c) { code = c; return res; },
        send(b) { body = b; },
        json(j) { body = JSON.stringify(j); },
        // Made to blow up partway through handling the request.
        setHeader(k) { if (k === 'Content-Type') throw new Error('boom from inside'); },
      };
      await m.default({ method: 'GET', headers: {} }, res);
      console.log(JSON.stringify({ code, mentionsError: body.includes('boom from inside') }));
    `);
    const result = JSON.parse(output.trim().split('\n').pop()!);
    expect(result.code).toBe(200);
    expect(result.mentionsError).toBe(true);
  }, 120_000);
});

describe('the account-minting endpoint survives real Node ESM', () => {
  test('loads, refuses GET, and says so plainly when unconfigured', () => {
    const output = buildAndRun(`
      delete process.env.VITE_SUPABASE_URL;
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      const m = await import('${OUT}/anon-session.js');
      const run = async (method) => {
        let code = 0, body = '';
        const res = {
          status(c) { code = c; return res; },
          json(j) { body = JSON.stringify(j); },
          setHeader() {},
        };
        await m.default({ method, headers: {} }, res);
        return { code, body };
      };
      const get = await run('GET');
      const post = await run('POST');
      console.log(JSON.stringify({
        get: get.code,
        post: post.code,
        explains: post.body.includes('SUPABASE_SERVICE_ROLE_KEY'),
      }));
    `);
    const result = JSON.parse(output.trim().split('\n').pop()!);
    // 405 for the wrong verb, 500 with a readable reason when the deployment
    // has no credentials -- never a blank FUNCTION_INVOCATION_FAILED.
    expect(result).toEqual({ get: 405, post: 500, explains: true });
  }, 120_000);

  test('a thrown error becomes readable JSON, never a blank crash', () => {
    // Same failure class as api/migrate.ts's equivalent test above, applied to
    // this endpoint's own top-level try/catch: forcing something unrelated to
    // the Supabase call to throw must still produce a readable JSON body
    // rather than an opaque platform-level failure.
    const output = buildAndRun(`
      process.env.VITE_SUPABASE_URL = 'https://testref123.supabase.co';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
      const m = await import('${OUT}/anon-session.js');
      let code = 0, body = '';
      const res = {
        status(c) { code = c; return res; },
        json(j) { body = JSON.stringify(j); },
        // Made to blow up partway through handling the request.
        setHeader() { throw new Error('boom from inside'); },
      };
      await m.default({ method: 'POST', headers: {} }, res);
      console.log(JSON.stringify({ code, mentionsError: body.includes('boom from inside') }));
    `);
    const result = JSON.parse(output.trim().split('\n').pop()!);
    expect(result.code).toBe(500);
    expect(result.mentionsError).toBe(true);
  }, 120_000);

  test('a hung or unreachable upstream still returns within the timeout budget, never forever', () => {
    // api/anon-session.ts's own weakness before this test existed: the fetch
    // to Supabase's admin API had no timeout, so a hung upstream meant the
    // ONLY thing that ever gave up was Vercel's platform-level gateway --
    // which returns a bare, unparseable 504 the client cannot show a reason
    // for. This points the handler at a reserved, non-routable address
    // (TEST-NET-1, RFC 5737) that a real network stack will either fail to
    // connect to immediately or hang on -- either way, this codes's own
    // AbortController-bounded timeout must win the race, well inside
    // UPSTREAM_TIMEOUT_MS (8s) plus a little overhead, with a body naming
    // what happened.
    const output = buildAndRun(`
      process.env.VITE_SUPABASE_URL = 'http://192.0.2.1';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
      const m = await import('${OUT}/anon-session.js');
      let code = 0, body = '';
      const res = {
        status(c) { code = c; return res; },
        json(j) { body = JSON.stringify(j); },
        setHeader() {},
      };
      const startedAt = Date.now();
      await m.default({ method: 'POST', headers: { 'x-forwarded-for': 'timeout-test' } }, res);
      console.log(JSON.stringify({ code, body, elapsedMs: Date.now() - startedAt }));
    `);
    const result = JSON.parse(output.trim().split('\n').pop()!);
    // 504 if it actually timed out, 502 if the sandbox refused the connection
    // outright -- either is a bounded, readable failure, which is the point.
    expect([502, 504]).toContain(result.code);
    expect(result.elapsedMs).toBeLessThan(9_500);
    const parsed = JSON.parse(result.body);
    expect(typeof parsed.error).toBe('string');
    expect(parsed.error.length).toBeGreaterThan(0);
  }, 120_000);

  test('a burst from one caller is throttled', () => {
    const output = buildAndRun(`
      const m = await import('${OUT}/anon-session.js');
      const results = [];
      for (let i = 0; i < 8; i++) results.push(m.rateLimited('1.2.3.4'));
      // A different caller is unaffected by the first one's burst.
      results.push(m.rateLimited('5.6.7.8'));
      console.log(JSON.stringify(results));
    `);
    const results = JSON.parse(output.trim().split('\n').pop()!) as boolean[];
    expect(results.slice(0, 5)).toEqual([false, false, false, false, false]);
    expect(results.slice(5, 8)).toEqual([true, true, true]);
    expect(results[8]).toBe(false);
  }, 120_000);
});

describe('relative imports carry the extension Node requires', () => {
  test('no extensionless relative import survives in api/', () => {
    // The exact mistake that broke the deployment. TypeScript is now configured
    // with nodenext so it enforces this too, but the check is cheap and the
    // failure was expensive.
    const offenders: string[] = [];

    for (const file of apiSources()) {
      const source = readFileSync(join(repoRoot, 'api', file), 'utf8');
      for (const match of source.matchAll(/from\s+'(\.[^']*)'/g)) {
        const specifier = match[1]!;
        if (!specifier.endsWith('.js')) offenders.push(`api/${file}: ${specifier}`);
      }
    }

    expect(offenders, 'Node ESM needs the .js extension on relative imports').toEqual([]);
  });
});
