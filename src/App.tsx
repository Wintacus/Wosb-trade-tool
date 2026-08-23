/**
 * Phase 0/1 placeholder.
 *
 * There is deliberately NO product UI here yet: SPEC.md builds the calculator
 * and its tests before anything visual (§0 "Build order rationale"). This page
 * exists only so the deployment is verifiable at the live URL, which is the
 * only way this project's work can be checked.
 *
 * Phase 2 replaces this file entirely.
 */
export default function App() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-6 py-12">
      <header className="flex flex-col gap-2">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">
          Unofficial fan tool
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">WOSB Trade Tool</h1>
        <p className="text-slate-400">
          Deployment is live. The trading calculator and its tests are built before any
          interface exists — there is nothing to click yet.
        </p>
      </header>

      <section className="rounded-lg border border-slate-700/60 p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">
          Build status
        </h2>
        <ul className="flex flex-col gap-2 text-sm">
          <li>
            <span aria-hidden="true">✅</span> Phase 0 — Vite + React + TypeScript, deployed
          </li>
          <li>
            <span aria-hidden="true">🔧</span> Phase 1 — schema, seed data and calculator
          </li>
          <li>
            <span aria-hidden="true">⬜</span> Phase 2 — map, ship picker, results
          </li>
        </ul>
      </section>

      <footer className="text-xs leading-relaxed text-slate-500">
        Not affiliated with, endorsed by, or connected to the developers of World of Sea
        Battle. Game data is community-contributed and may be wrong or out of date.
      </footer>
    </main>
  );
}
