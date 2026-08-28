/**
 * One hash of everything the verification gate watches.
 *
 * `.verified` records this value, and the Stop hook compares against it. Both
 * used to compute it with their own copy of a `find | sha1sum` pipeline, which
 * is a silent-failure waiting to happen: the moment the two drift the gate
 * still passes, but it is no longer checking what it claims to. One command,
 * called by both, cannot drift.
 *
 * WHAT IS WATCHED, and why each earns its place:
 *
 *   src/       the app
 *   api/       the serverless functions
 *   supabase/  migrations and schema. Added 2026-08-27 after noticing they were
 *              outside the gate -- a migration is the highest-risk change in
 *              this project, because it runs against the REAL database during
 *              the deploy, and it could ship without the app ever being driven.
 *   scripts/   the harness itself. Editing verify-ui.mjs must invalidate the
 *              stamp: a changed harness has not been run.
 *
 * The path is hashed alongside the content, so renaming a file is a change
 * even when nothing inside it moved.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const WATCHED_DIRS = ['src', 'api', 'supabase', 'scripts'];
const EXTENSIONS = /\.(ts|tsx|css|sql|mjs|js)$/;

/** Directories whose contents are build output or scratch, never source. */
const SKIP = new Set(['node_modules', 'dist', '.apitest', '.vercel']);

function walk(dir, found = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return found; // A watched directory need not exist.
  }
  for (const entry of entries.sort()) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, found);
    else if (EXTENSIONS.test(entry)) found.push(full);
  }
  return found;
}

export function treeHash() {
  const digest = createHash('sha1');
  // Sorted so the hash depends on which files exist and what is in them, not
  // on the order the filesystem happened to hand them over.
  const files = WATCHED_DIRS.flatMap((dir) => walk(dir)).sort();
  for (const file of files) {
    digest.update(file);
    digest.update('\0');
    digest.update(readFileSync(file));
    digest.update('\0');
  }
  return digest.digest('hex');
}

// `node scripts/tree-hash.mjs` prints the hash; importing gives the function.
if (process.argv[1] && process.argv[1].endsWith('tree-hash.mjs')) {
  process.stdout.write(treeHash() + '\n');
}
