import type { ReactNode } from 'react';

/**
 * The handful of shared shapes every screen uses.
 *
 * Kept deliberately small. This is a functional tool, not a design system —
 * illustrated art is Phase 5, and DESIGN_BRIEF.md governs it when it arrives.
 */

export function Panel({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-5 ${className}`}
    >
      {children}
    </section>
  );
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  disabled = false,
  type = 'button',
  className = '',
  title,
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
  className?: string;
  title?: string;
  ariaLabel?: string;
}) {
  const base =
    // min-h-11 keeps every control at a comfortable thumb target: this app is
    // used on a phone first and a desktop second.
    'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium ' +
    'transition-colors disabled:cursor-not-allowed disabled:opacity-40 ' +
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400';
  const variants = {
    primary: 'bg-amber-400 text-slate-950 hover:bg-amber-300',
    secondary: 'border border-slate-700 bg-slate-800/70 text-slate-100 hover:bg-slate-700',
    ghost: 'text-slate-300 hover:bg-slate-800/60 hover:text-slate-100',
    danger: 'border border-red-500/50 bg-red-500/10 text-red-200 hover:bg-red-500/20',
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      className={`${base} ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * A caveat attached to a number.
 *
 * SPEC 5 and CLAUDE.md rule 5 both insist on this: if the calculator leaned on
 * a value nobody has verified, the result says so out loud. A confidently
 * presented wrong number is worse than an honest gap.
 */
export function Caveat({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2 text-sm text-amber-200/90">
      <span aria-hidden="true">⚠</span>
      <span>{children}</span>
    </p>
  );
}

export function Stat({
  label,
  value,
  hint,
  emphasis = false,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2">
      <dt className="text-xs tracking-wide text-slate-400 uppercase">{label}</dt>
      <dd
        className={`mt-0.5 font-semibold tabular-nums ${
          emphasis ? 'text-2xl text-amber-300' : 'text-lg text-slate-100'
        }`}
      >
        {value}
      </dd>
      {hint ? <dd className="mt-0.5 text-xs text-slate-500">{hint}</dd> : null}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-3 text-slate-400">
      <span
        aria-hidden="true"
        className="size-4 animate-spin rounded-full border-2 border-slate-600 border-t-amber-400"
      />
      {label}
    </p>
  );
}

export function ErrorNote({ title, detail }: { title: string; detail: string }) {
  return (
    <div
      role="alert"
      className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-red-100"
    >
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-sm break-words text-red-200/90">{detail}</p>
    </div>
  );
}
