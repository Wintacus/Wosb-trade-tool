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
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

// Post-baseline schema changes, in filename order. Each carries a checksum so
// an already-applied file that has since been edited is reported rather than
// silently re-run.
const migrationsDir = join(root, 'supabase', 'migrations');
const migrations = existsSync(migrationsDir)
  ? readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => {
        const sql = readFileSync(join(migrationsDir, name), 'utf8');
        return {
          name,
          checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16),
          sql,
        };
      })
  : [];

const migrationsLiteral = migrations.length
  ? migrations
      .map(
        (m) =>
          `  {\n    name: '${m.name}',\n    checksum: '${m.checksum}',\n    sql: \`${embed(m.sql)}\`,\n  },`,
      )
      .join('\n')
  : '';

const output = `/**
 * GENERATED FILE. Do not edit by hand: run \`npm run gen:sql\`.
 *
 * The contents of supabase/*.sql, embedded so the serverless migrate endpoint
 * carries them in its own bundle rather than reading from disk.
 */

${parts.join('\n\n')}

export interface Migration {
  name: string;
  checksum: string;
  sql: string;
}

/** Post-baseline schema changes, applied in this order. */
export const migrations: Migration[] = [
${migrationsLiteral}
];
`;

mkdirSync(join(root, 'api'), { recursive: true });
writeFileSync(join(root, 'api', '_sql.ts'), output, 'utf8');

console.log(
  `Wrote api/_sql.ts: embedded ${FILES.join(', ')}` +
    ` plus ${migrations.length} migration${migrations.length === 1 ? '' : 's'}.`,
);
