import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // PGlite (real Postgres compiled to WebAssembly) boots a database in-process
    // for the schema/view tests. First boot is slow, so allow headroom.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
