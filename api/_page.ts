/**
 * HTML for the setup page.
 *
 * Hand-written rather than pulled from the React app, because this runs inside
 * a serverless function with no bundler. It is intentionally plain: large tap
 * targets, one input, one button, readable on a phone.
 */

const STYLE = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 20px 64px;
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0b1120; color: #e2e8f0;
  }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 8px; letter-spacing: -0.02em; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .12em;
       color: #94a3b8; margin: 32px 0 10px; }
  p { margin: 0 0 14px; color: #cbd5e1; }
  .muted { color: #94a3b8; font-size: 14px; }
  label { display: block; font-weight: 600; margin: 0 0 6px; }
  input[type=password], input[type=text] {
    width: 100%; padding: 15px 14px; font-size: 17px;
    border-radius: 10px; border: 1px solid #334155;
    background: #111827; color: #f8fafc;
  }
  input:focus { outline: 2px solid #38bdf8; outline-offset: 1px; }
  button {
    width: 100%; margin-top: 16px; padding: 17px 20px;
    font-size: 17px; font-weight: 600; border: 0; border-radius: 10px;
    background: #0284c7; color: #fff; cursor: pointer;
  }
  button:disabled { background: #334155; color: #94a3b8; }
  a { color: #7dd3fc; }
  .card { border: 1px solid #1e293b; border-radius: 12px; padding: 16px; margin: 0 0 16px;
          background: #0f172a; }
  .row { display: flex; gap: 10px; padding: 9px 0; border-bottom: 1px solid #1e293b; }
  .row:last-child { border-bottom: 0; }
  .row .what { flex: 1; min-width: 0; }
  .ok { color: #4ade80; } .bad { color: #f87171; }
  .banner { padding: 16px; border-radius: 12px; font-weight: 600; margin: 0 0 20px; }
  .banner.good { background: #052e16; border: 1px solid #166534; color: #86efac; }
  .banner.fail { background: #300f0f; border: 1px solid #7f1d1d; color: #fca5a5; }
  details { margin-top: 22px; }
  summary { cursor: pointer; color: #94a3b8; font-size: 14px; padding: 8px 0; }
  code { background: #1e293b; padding: 1px 5px; border-radius: 4px; font-size: 13px;
         word-break: break-all; }
  .err { color: #fca5a5; margin-top: 14px; white-space: pre-wrap; font-size: 14px; }
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function setupPage(projectRef: string | null): string {
  const found = projectRef
    ? `<p class="muted">Supabase project <code>${escapeHtml(projectRef)}</code> detected
       automatically. Nothing else is needed.</p>`
    : `<p class="err">VITE_SUPABASE_URL is not set in this deployment, so the project could not
       be identified. Use the advanced box below.</p>`;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>Set up the database</title>
<style>${STYLE}</style>
</head><body><main>

<h1>Set up the database</h1>
<p>This creates every table, switches on row-level security, and loads the ports, ships,
goods and upgrades. It is safe to run more than once.</p>
${found}

<form method="post" id="f">
  <div class="card">
    <label for="password">Supabase database password</label>
    <input type="password" id="password" name="password" autocomplete="off"
           autocapitalize="off" autocorrect="off" spellcheck="false"
           placeholder="the password you set when creating the project">
    <p class="muted" style="margin:10px 0 0">
      Not the anon key, and not your Supabase account password &mdash; the
      <em>database</em> password. Forgotten it?
      <a href="https://supabase.com/dashboard/project/_/settings/database" target="_blank"
         rel="noreferrer noopener">Reset it here</a>, then paste the new one.
      It is used to open one connection and is never stored.
    </p>
  </div>

  <label style="font-weight:400;color:#cbd5e1">
    <input type="checkbox" name="demo" value="true" checked style="width:auto;margin-right:8px">
    Also load demo prices, so the calculator has something to work with
  </label>

  <button type="submit" id="go">Set up the database</button>

  <details>
    <summary>Advanced &mdash; paste a full connection string instead</summary>
    <p class="muted">Only needed if the automatic host detection fails.</p>
    <input type="text" name="connectionString" autocomplete="off" spellcheck="false"
           placeholder="postgresql://postgres:...@...supabase.com:5432/postgres">
  </details>
</form>

<script>
  var form = document.getElementById('f');
  var go = document.getElementById('go');
  form.addEventListener('submit', function () {
    go.disabled = true;
    go.textContent = 'Working, this can take up to a minute...';
  });
</script>

</main></body></html>`;
}

export interface ResultInput {
  ok: boolean;
  steps: { step: string; ok: boolean; detail: string }[];
  counts: { label: string; found: number; expected: number; ok: boolean }[];
  prices: number;
  portState: number;
  /** Overrides the banner wording. Used by the no-password update path. */
  heading?: string;
}

export function resultPage(input: ResultInput): string {
  const { ok, steps, counts, prices, portState, heading } = input;

  const stepRows = steps
    .map(
      (s) => `<div class="row">
        <span class="${s.ok ? 'ok' : 'bad'}" aria-hidden="true">${s.ok ? '&#10003;' : '&#10007;'}</span>
        <span class="what"><strong>${escapeHtml(s.step)}</strong><br>
        <span class="muted">${escapeHtml(s.detail)}</span></span>
      </div>`,
    )
    .join('');

  const countRows = counts
    .map(
      (c) => `<div class="row">
        <span class="${c.ok ? 'ok' : 'bad'}" aria-hidden="true">${c.ok ? '&#10003;' : '&#10007;'}</span>
        <span class="what">${escapeHtml(c.label)}</span>
        <span class="${c.ok ? 'ok' : 'bad'}">${c.found} / ${c.expected}</span>
      </div>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${ok ? 'Database ready' : 'Setup failed'}</title>
<style>${STYLE}</style>
</head><body><main>

<div class="banner ${ok ? 'good' : 'fail'}">
  ${escapeHtml(heading ?? (ok ? 'Database is set up and verified.' : 'Something went wrong. Details below.'))}
</div>

<h2>What happened</h2>
<div class="card">${stepRows}</div>

${
  counts.length
    ? `<h2>Row counts</h2><div class="card">${countRows}</div>
       <p class="muted">${prices} price rows and ${portState} port records are available.</p>`
    : ''
}

${
  ok
    ? `<p><a href="/">Open the app</a> to see the live checks.</p>`
    : `<p><a href="/api/migrate">Try again</a></p>`
}

</main></body></html>`;
}
