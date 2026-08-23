import { schemaSql, migrations, type Migration } from './_sql.js';

/**
 * Applying schema changes without the database password.
 *
 * The deployed site already holds the service role key. Once schema.sql has
 * been applied once (which does need the password, to bootstrap), the database
 * carries an `apply_migration` function that only that key may call. From then
 * on a schema change is a push: no password, nothing for anyone to do by hand.
 *
 * Everything here talks to PostgREST over HTTPS rather than opening a Postgres
 * connection, so it needs no database credentials at all.
 */

export interface AutoStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface AutoResult {
  ok: boolean;
  steps: AutoStep[];
  applied: string[];
  skipped: string[];
}

interface Rest {
  url: string;
  key: string;
}

function rest(): Rest | null {
  const url = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '').trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ''), key };
}

/** Ask the database to run a statement, through the locked-down function. */
async function applySql(target: Rest, sql: string): Promise<void> {
  const response = await fetch(`${target.url}/rest/v1/rpc/apply_migration`, {
    method: 'POST',
    headers: {
      apikey: target.key,
      Authorization: `Bearer ${target.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ migration_sql: sql }),
  });

  if (!response.ok) {
    const body = await response.text();
    // A missing function means the password-based setup has never run, which
    // is a different problem with a different fix, so say so precisely.
    if (response.status === 404 || /apply_migration/.test(body)) {
      throw new Error(
        'The database has no apply_migration function yet. Run the one-time ' +
          'setup at /api/migrate first; automatic updates work after that.',
      );
    }
    throw new Error(`${response.status} ${body.slice(0, 400)}`);
  }
}

async function recorded(target: Rest): Promise<Map<string, string>> {
  const response = await fetch(
    `${target.url}/rest/v1/schema_migrations?select=name,checksum`,
    {
      headers: {
        apikey: target.key,
        Authorization: `Bearer ${target.key}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Could not read schema_migrations: ${response.status}`);
  }
  const rows = (await response.json()) as { name: string; checksum: string }[];
  return new Map(rows.map((r) => [r.name, r.checksum]));
}

async function record(target: Rest, migration: Migration): Promise<void> {
  const response = await fetch(`${target.url}/rest/v1/schema_migrations`, {
    method: 'POST',
    headers: {
      apikey: target.key,
      Authorization: `Bearer ${target.key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ name: migration.name, checksum: migration.checksum }),
  });
  if (!response.ok) {
    throw new Error(`Could not record ${migration.name}: ${response.status}`);
  }
}

/**
 * Bring the database up to date with what this deployment expects.
 *
 * schema.sql runs every time. It only ever creates what is absent and replaces
 * views and policies wholesale, so re-running it is how new tables and changed
 * policies arrive. Migrations handle what it cannot: altering something that
 * already exists.
 */
export async function applyPendingChanges(
  // Injectable so the ordering, skipping and drift-detection rules can be
  // tested without inventing throwaway migration files.
  pending: readonly Migration[] = migrations,
): Promise<AutoResult> {
  const steps: AutoStep[] = [];
  const applied: string[] = [];
  const skipped: string[] = [];

  const target = rest();
  if (!target) {
    return {
      ok: false,
      steps: [
        {
          step: 'Configuration',
          ok: false,
          detail:
            'VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing from this ' +
            'deployment, so automatic updates cannot run.',
        },
      ],
      applied,
      skipped,
    };
  }

  try {
    const started = Date.now();
    await applySql(target, schemaSql);
    steps.push({
      step: 'Base schema',
      ok: true,
      detail: `Re-applied in ${Date.now() - started}ms. Creates only what is missing.`,
    });
  } catch (error) {
    steps.push({
      step: 'Base schema',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, steps, applied, skipped };
  }

  let done: Map<string, string>;
  try {
    done = await recorded(target);
  } catch (error) {
    steps.push({
      step: 'Read applied migrations',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, steps, applied, skipped };
  }

  for (const migration of pending) {
    const previous = done.get(migration.name);

    if (previous === migration.checksum) {
      skipped.push(migration.name);
      continue;
    }

    if (previous !== undefined) {
      // Editing an applied migration means the database and the file disagree
      // and no automatic action is safe. Rerunning could double-apply; skipping
      // hides a real difference. Report it and stop.
      steps.push({
        step: migration.name,
        ok: false,
        detail:
          'Already applied, but the file has changed since. Add a new migration ' +
          'instead of editing one that has run.',
      });
      return { ok: false, steps, applied, skipped };
    }

    try {
      await applySql(target, migration.sql);
      await record(target, migration);
      applied.push(migration.name);
      steps.push({ step: migration.name, ok: true, detail: 'Applied.' });
    } catch (error) {
      steps.push({
        step: migration.name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, steps, applied, skipped };
    }
  }

  steps.push({
    step: 'Migrations',
    ok: true,
    detail:
      applied.length > 0
        ? `${applied.length} applied, ${skipped.length} already up to date.`
        : `Nothing pending. ${skipped.length} already applied.`,
  });

  return { ok: true, steps, applied, skipped };
}
