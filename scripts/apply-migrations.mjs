/**
 * Applies pending schema changes as part of the Vercel build.
 *
 * This is what makes a schema change a push and nothing more. Vercel runs the
 * build with the project's environment variables, so the service role key is
 * available here, and `apply_migration` in the database does the rest. No
 * password, no URL to tap, no cron to wait for.
 *
 * It reuses api/_auto.ts rather than restating its logic, because that file is
 * the one covered by tests, including against a real Postgres. A second copy
 * of the rules would drift from the tested one exactly when it mattered.
 *
 * A failure here does NOT fail the build. A database hiccup should not block a
 * deployment for someone who can only work from a phone; the site's own status
 * page reports the drift, and /api/migrate?auto=1 retries on demand.
 */
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Skip silently where there is nothing to talk to: a local build, CI, or a
// preview without the key. Saying so is useful; failing would be noise.
if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.VITE_SUPABASE_URL) {
  console.log(
    '[migrate] No Supabase credentials in this environment, so no schema changes applied.',
  );
  process.exit(0);
}

const out = mkdtempSync(join(tmpdir(), 'wosb-migrate-'));

try {
  await build({
    entryPoints: [join(root, 'api', '_auto.ts')],
    outfile: join(out, 'auto.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'error',
  });

  const { applyPendingChanges } = await import(pathToFileURL(join(out, 'auto.mjs')).href);
  const result = await applyPendingChanges();

  for (const step of result.steps) {
    console.log(`[migrate] ${step.ok ? 'ok  ' : 'FAIL'} ${step.step}: ${step.detail}`);
  }

  if (result.ok) {
    console.log(
      result.applied.length > 0
        ? `[migrate] Applied ${result.applied.length}: ${result.applied.join(', ')}`
        : '[migrate] Database already up to date.',
    );
  } else {
    // Loud, but not fatal. The deployment still goes out and the status page
    // will show that the database is behind.
    console.error('[migrate] Schema changes did NOT apply. The site will report this.');
    console.error('[migrate] Retry at /api/migrate?auto=1 once the cause is fixed.');
  }
} catch (error) {
  console.error(
    `[migrate] Could not run schema changes: ${error instanceof Error ? error.message : String(error)}`,
  );
  console.error('[migrate] Deployment continues; the site will report the database as behind.');
} finally {
  rmSync(out, { recursive: true, force: true });
}
