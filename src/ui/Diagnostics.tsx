import { useEffect, useState } from 'react';
import { runDiagnostics, type Check, type CheckStatus } from '../lib/diagnostics';
import { Button, Panel } from './Ui';

/**
 * The database self-check, kept from Phase 0/1.
 *
 * This used to be the whole app. Phase 2 replaced the root with the product
 * UI, but the checks stay reachable at ?diagnostics=1 because this project is
 * only ever verified at its deployed URL: "is the schema actually applied" is
 * otherwise not a question that can be answered from a phone.
 *
 * Every check runs in the browser with the publishable key, so it reflects what
 * an ordinary visitor can reach rather than what a privileged connection can do.
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

export function Diagnostics({ onBack }: { onBack: () => void }) {
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
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Database checks</h2>
        <Button onClick={onBack}>← Back to the tool</Button>
      </div>

      <Panel>
        <p className="mb-3 text-sm text-slate-400">
          Run live, in this browser, using the publishable key.
        </p>

        {failed && (
          <p className="rounded border border-red-900 bg-red-950/40 p-3 text-sm" role="alert">
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
      </Panel>

      <Panel>
        <h3 className="text-sm font-semibold tracking-wider text-slate-400 uppercase">
          If a check fails
        </h3>
        {/*
          This used to tell the user to open the Supabase dashboard and run SQL
          by hand. That instruction was wrong: schema changes apply during the
          Vercel build, so the fix is a deploy, not a chore for the user.
        */}
        <p className="mt-2 text-sm text-slate-400">
          Nothing here needs doing by hand. Schema changes are applied
          automatically during the deploy, so a failing check means the last
          deploy did not finish, not that a step was missed. Re-deploying, or
          pushing any commit, runs the migrations again.
        </p>
      </Panel>
    </div>
  );
}
