import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The build stamp.
 *
 * This exists because of a real cost, twice paid: a fix was pushed, the user
 * tested it on a phone, saw the old behaviour, and reported it as still
 * broken. There was no way from either side to tell whether they were looking
 * at the new build or a stale one, so the next hour went into re-diagnosing a
 * bug that was already fixed.
 *
 * Vercel sets VERCEL_GIT_COMMIT_SHA during the build. Baking it into the
 * bundle means the running page can always say which commit it came from, so
 * "is this actually the new code?" becomes a question anyone can answer in
 * two seconds instead of an assumption.
 *
 * The commit SHA of a public repository is not a secret, so putting it in the
 * browser bundle is safe (CLAUDE.md hard rule 4 concerns credentials).
 */
const commitSha = (
  process.env.VERCEL_GIT_COMMIT_SHA ??
  process.env.GITHUB_SHA ??
  ''
).slice(0, 7);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __BUILD_SHA__: JSON.stringify(commitSha || 'local'),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
});
