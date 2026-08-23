import { afterAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
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

function buildAndRun(script: string): string {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  execFileSync(
    'npx',
    [
      'esbuild',
      'api/migrate.ts',
      'api/_page.ts',
      'api/_sql.ts',
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

describe('relative imports carry the extension Node requires', () => {
  test('no extensionless relative import survives in api/', () => {
    // The exact mistake that broke the deployment. TypeScript is now configured
    // with nodenext so it enforces this too, but the check is cheap and the
    // failure was expensive.
    const files = ['migrate.ts', '_page.ts', '_sql.ts'];
    const offenders: string[] = [];

    for (const file of files) {
      const source = execFileSync('cat', [join(repoRoot, 'api', file)], {
        encoding: 'utf8',
      });
      for (const match of source.matchAll(/from\s+'(\.[^']*)'/g)) {
        const specifier = match[1]!;
        if (!specifier.endsWith('.js')) offenders.push(`api/${file}: ${specifier}`);
      }
    }

    expect(offenders, 'Node ESM needs the .js extension on relative imports').toEqual([]);
  });
});
