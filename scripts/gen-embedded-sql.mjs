/**
 * Embeds the three SQL files into a TypeScript module.
 *
 * The migrate endpoint runs as a Vercel serverless function, which does not
 * reliably get the repository's files on disk. Bundling the SQL as strings
 * removes that whole class of failure: if the function deploys at all, it has
 * the SQL.
 *
 * Re-run with:  npm run gen:sql
 * A test asserts this file matches supabase/*.sql, so they cannot drift.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const FILES = ['schema.sql', 'seed.sql', 'demo_prices.sql'];

/** Escape for a TypeScript template literal. */
const embed = (text) => text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const parts = FILES.map((name) => {
  const sql = readFileSync(join(root, 'supabase', name), 'utf8');
  const key = name.replace('.sql', '').replace(/_(\w)/g, (_, c) => c.toUpperCase());
  return `export const ${key}Sql = \`${embed(sql)}\`;`;
});

const output = `/**
 * GENERATED FILE. Do not edit by hand: run \`npm run gen:sql\`.
 *
 * The contents of supabase/*.sql, embedded so the serverless migrate endpoint
 * carries them in its own bundle rather than reading from disk.
 */

${parts.join('\n\n')}
`;

mkdirSync(join(root, 'api'), { recursive: true });
writeFileSync(join(root, 'api', '_sql.ts'), output, 'utf8');

console.log(`Wrote api/_sql.ts: embedded ${FILES.join(', ')}.`);
