import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { repoRoot } from './pg';

/**
 * Guards that no server-only secret can reach the browser.
 *
 * Vite bundles a variable into client code if, and only if, its name starts
 * with VITE_. So the rule is mechanical: client code may read VITE_ variables
 * and Vite's own built-ins, and nothing else. SUPABASE_SERVICE_ROLE_KEY
 * bypasses row-level security entirely and ANTHROPIC_API_KEY spends money, so
 * both belong exclusively inside serverless functions.
 *
 * Grepping the built bundle is not a good check on its own: @supabase/
 * supabase-js contains the literal string "sb_secret_" because it checks key
 * prefixes, which looks alarming and means nothing. Checking what the source
 * actually reads is precise.
 */

/** Variables Vite itself provides to client code. */
const VITE_BUILTINS = new Set(['MODE', 'DEV', 'PROD', 'BASE_URL', 'SSR', 'LEGACY']);

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Tests run in Node, not the browser, so they are not bundled.
      if (entry === 'test') continue;
      sourceFiles(full, found);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

describe('client code cannot read server-only secrets', () => {
  const clientFiles = sourceFiles(join(repoRoot, 'src'));

  test('there is client code to check', () => {
    expect(clientFiles.length).toBeGreaterThan(0);
  });

  test('every environment variable read in the browser is VITE_ prefixed', () => {
    const offenders: string[] = [];

    for (const file of clientFiles) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
        const name = match[1]!;
        if (name.startsWith('VITE_') || VITE_BUILTINS.has(name)) continue;
        offenders.push(`${relative(repoRoot, file)}: import.meta.env.${name}`);
      }
    }

    expect(offenders, 'these would be bundled into the browser').toEqual([]);
  });

  test('client code never names a server-only variable directly', () => {
    const forbidden = /\b(SUPABASE_SERVICE_ROLE_KEY|ANTHROPIC_API_KEY)\b/;
    const offenders: string[] = [];

    for (const file of clientFiles) {
      for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        // A comment explaining why a key must stay server-side is fine; code
        // that actually references one is not.
        const withoutComments = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (forbidden.test(withoutComments)) {
          offenders.push(`${relative(repoRoot, file)}:${index + 1}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('no .env file is tracked, and .gitignore excludes it from the first commit', () => {
    const gitignore = readFileSync(join(repoRoot, '.gitignore'), 'utf8');
    expect(gitignore).toMatch(/^\.env$/m);
    // A committed key stays in git history forever, so the fix is to rotate it.
    expect(gitignore).toMatch(/rotate/i);
  });

  test('.env.example carries names only, never values', () => {
    const example = readFileSync(join(repoRoot, '.env.example'), 'utf8');
    for (const line of example.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [, value = ''] = trimmed.split('=');
      // Anything after the "=" must be empty or an inline comment.
      expect(value.trim().replace(/#.*$/, '').trim()).toBe('');
    }
  });
});
