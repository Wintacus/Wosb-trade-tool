import { useEffect, useState } from 'react';
import { runDiagnostics, type Check, type CheckStatus } from './lib/diagnostics';

/**
 * Phase 0/1 status page.
 *
 * This is NOT the product UI. SPEC.md builds the calculator and its tests
 * before anything visual (0, "Build order rationale"), and Phase 2 replaces
 * this file entirely.
 *
 * It exists because this project is only ever verified at its deployed URL,
 * and "the schema is set up correctly" is otherwise not something that can be
 * checked from a phone. Every check below runs in the browser with the
 * publishable key, so it reflects what an ordinary visitor can actually reach.
 */

const STATUS_ICON: Record<CheckStatus, string> = {
  pass: '✅',
  fail: '❌',
  warn: '⚠️',
  pending: '⏳',
};

const STATUS_LABEL: Record<CheckStatus, string> = {
  pass: 'Pass',
  fail: 'Fail',
  warn: 'Warning',
  pending: 'Checking',
};

function CheckRow({ check }: { check: Check }) {
  return (
    <li className="flex gap-3 border-b border-slate-800 py-3 last:border-b-0">
      <span aria-hidden="true" className="mt-0.5 shrink-0">
        {STATUS_ICON[check.status]}
      </span>
      <div className="min-w-0">
        <p className="font-medium">
          {check.label}
          {/* Never rely on colour or an icon alone to carry meaning. */}
          <span className="sr-only"> — {STATUS_LABEL[check.status]}</span>
        </p>
        <p className="text-sm break-words text-slate-400">{check.detail}</p>
      </div>
    </li>
  );
}

export default function App() {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    runDiagnostics()
      .then((result) => {
        if (!cancelled) setChecks(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailed(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const failures = checks?.filter((c) => c.status === 'fail').length ?? 0;

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-2">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">
          Unofficial fan tool
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">WOSB Trade Tool</h1>
        <p className="text-slate-400">
          Setup status. There is no interface yet by design: the calculator and its
          tests are built and verified before anything visual.
        </p>
      </header>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">
          Build phases
        </h2>
        <ul className="flex flex-col gap-2 text-sm">
          <li>
            <span aria-hidden="true">✅</span> Phase 0 — deployed and reachable
          </li>
          <li>
            <span aria-hidden="true">✅</span> Phase 1 — schema, seed data, calculator, tests
          </li>
          <li>
            <span aria-hidden="true">⬜</span> Phase 2 — map, ship picker, results
          </li>
        </ul>
      </section>

      <section>
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-slate-400">
          Database checks
        </h2>
        <p className="mb-3 text-sm text-slate-500">
          Run live, in this browser, using the publishable key.
        </p>

        {failed && (
          <p className="rounded border border-red-900 bg-red-950/40 p-3 text-sm">
            The checks could not run: {failed}
          </p>
        )}

        {!checks && !failed && <p className="text-sm text-slate-400">Checking…</p>}

        {checks && (
          <>
            <p className="mb-3 text-sm">
              {failures === 0 ? (
                <span>All {checks.length} checks passed.</span>
              ) : (
                <span>
                  {failures} of {checks.length} checks failed.
                </span>
              )}
            </p>
            <ul className="rounded-lg border border-slate-800 px-4">
              {checks.map((check) => (
                <CheckRow key={check.id} check={check} />
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="text-sm text-slate-400">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
          If the database checks fail
        </h2>
        <p>
          Open the Supabase dashboard, go to SQL Editor, and run the files in{' '}
          <code className="text-slate-300">supabase/</code> in order:{' '}
          <code className="text-slate-300">schema.sql</code>, then{' '}
          <code className="text-slate-300">seed.sql</code>, then optionally{' '}
          <code className="text-slate-300">demo_prices.sql</code>. Each one checks its
          own row counts and stops if anything is short.
        </p>
      </section>

      <footer className="mt-auto text-xs leading-relaxed text-slate-500">
        Not affiliated with, endorsed by, or connected to the developers of World of Sea
        Battle. Game data is community-contributed and may be wrong or out of date.
      </footer>
    </main>
  );
}
