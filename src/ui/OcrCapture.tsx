import { useEffect, useRef, useState } from 'react';
import {
  ACCEPTED_TYPES,
  ocrReadiness,
  readScreenshot,
  type Extraction,
  type MergeResult,
  type Readiness,
} from '../data/ocr';
import { Button, ErrorNote } from './Ui';

/**
 * Read the prices off a screenshot instead of typing them (SPEC.md 7.2).
 *
 * This sits above the manual sheet and fills it in. It never saves anything —
 * the values land in the same fields a person types into, marked as machine
 * read, and the existing Save button is still what commits them. That is the
 * "always show the review screen" safeguard, built by not having a second path
 * to the database at all rather than by remembering to show a dialog.
 *
 * It is framed as experimental on screen, because it is: it has not yet been
 * measured against a wide range of real screenshots, and saying so is cheaper
 * than a confident wrong number.
 */
export function OcrCapture({
  portName,
  onApply,
  disabled,
}: {
  /** The port the sheet is currently saving to, for the mismatch check below. */
  portName: string;
  onApply: (extraction: Extraction) => MergeResult;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ extraction: Extraction; merge: MergeResult } | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);

  // Asked once, so nobody is invited to upload into a feature that is switched
  // off and then handed an error for their trouble.
  useEffect(() => {
    let cancelled = false;
    void ocrReadiness().then((value) => {
      if (!cancelled) setReadiness(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function pick(file: File | null) {
    if (!file) return;
    setError(null);
    setResult(null);
    setBusy('Preparing the image…');
    try {
      // Deliberately not a progress bar: there is one long step and inventing
      // percentages for it would be a lie told sixty times a session.
      setBusy('Reading the screenshot…');
      const extraction = await readScreenshot(file);
      const merge = onApply(extraction);
      setResult({ extraction, merge });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
      // Let the same file be picked twice — after a failure that is exactly
      // what someone tries first, and without this the input ignores it.
      if (input.current) input.current.value = '';
    }
  }

  const extraction = result?.extraction ?? null;
  const mismatch = extraction?.portName ? !namesAgree(extraction.portName, portName) : false;

  return (
    <section className="mt-4 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-slate-100">
            Read a screenshot{' '}
            <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-slate-400">
              experimental
            </span>
          </p>
          <p className="text-xs text-slate-500">
            Fills the boxes below. Nothing is saved until you check it and press Save.
          </p>
        </div>
        {readiness && !readiness.ready ? (
          <p className="text-xs text-slate-500">Switched off on this deployment</p>
        ) : (
          <Button
            onClick={() => input.current?.click()}
            disabled={disabled || busy !== null}
          >
            {busy ? 'Reading…' : 'Choose screenshot'}
          </Button>
        )}
      </div>

      {readiness && !readiness.ready ? (
        <p className="mt-2 text-xs text-slate-500">
          {readiness.missing.length > 0
            ? `${readiness.missing.join(' and ')} is not set for this deployment, so screenshots cannot be read. `
            : 'Screenshot reading is not configured on this deployment. '}
          Everything below still works — type in what you can see.
        </p>
      ) : null}

      <input
        ref={input}
        type="file"
        accept={ACCEPTED_TYPES.join(',')}
        className="sr-only"
        aria-label="Screenshot of the market screen"
        onChange={(event) => void pick(event.target.files?.[0] ?? null)}
      />

      {busy ? (
        <p role="status" className="mt-3 text-sm text-slate-300">
          {busy} This takes a few seconds.
        </p>
      ) : null}

      {error ? (
        <div className="mt-3">
          <ErrorNote title="Nothing was read" detail={error} />
        </div>
      ) : null}

      {result && extraction ? (
        <div className="mt-3 flex flex-col gap-2 text-sm">
          <p
            role="status"
            className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sky-100"
          >
            Filled {result.merge.filled}{' '}
            {result.merge.filled === 1 ? 'value' : 'values'} from{' '}
            {extraction.rows.length} {extraction.rows.length === 1 ? 'row' : 'rows'}.
            {result.merge.kept > 0
              ? ` ${result.merge.kept} you had already typed were left as they were.`
              : ''}{' '}
            Check them against the game before saving.
          </p>

          {/*
            The single most damaging mistake this feature can make is saving a
            correct reading against the wrong port -- it is invisible, it is
            permanent, and it poisons the route the calculator recommends. The
            screenshot usually names the port, so it can be compared.
          */}
          {mismatch ? (
            <p
              role="alert"
              className="rounded-lg border border-red-500/50 bg-red-500/10 px-3 py-2 text-red-100"
            >
              That screenshot looks like <strong>{extraction.portName}</strong>, but these
              prices will be saved to <strong>{portName}</strong>. Change the port above if
              that is wrong.
            </p>
          ) : null}

          {extraction.rejected.length > 0 ? (
            <details className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
              <summary className="cursor-pointer text-slate-300">
                {extraction.rejected.length} {extraction.rejected.length === 1 ? 'row was' : 'rows were'} skipped
              </summary>
              <ul className="mt-2 list-disc pl-5 text-xs text-slate-400">
                {extraction.rejected.map((row, index) => (
                  <li key={`${row.printed}-${index}`}>
                    “{row.printed}” — {row.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {extraction.notes ? (
            <p className="text-xs text-slate-500">Reader’s note: {extraction.notes}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Whether two port names refer to the same place.
 *
 * Loose on purpose. The game prints decoration around the name and the app
 * stores it plainly, so an exact comparison would cry wolf on every upload and
 * be ignored within a day. Either name containing the other is enough.
 */
export function namesAgree(fromImage: string, selected: string): boolean {
  const a = normalise(fromImage);
  const b = normalise(selected);
  if (!a || !b) return true;
  return a.includes(b) || b.includes(a);
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
