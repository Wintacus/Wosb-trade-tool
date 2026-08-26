import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The same build-time constants vite.config.ts bakes in. This config is
  // separate from the app's, so without repeating them here every component
  // that renders the footer throws under test with "__BUILD_SHA__ is not
  // defined" — which is exactly how this was caught.
  define: {
    __BUILD_SHA__: JSON.stringify('test'),
    __BUILD_TIME__: JSON.stringify('1970-01-01T00:00:00.000Z'),
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // PGlite (real Postgres compiled to WebAssembly) boots a database in-process
    // for the schema/view tests. First boot is slow, so allow headroom.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
