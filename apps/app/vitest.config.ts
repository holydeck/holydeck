import { defineConfig } from 'vitest/config';

import { coverageFloor, testRetry } from '../../vitest.base.js';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    retry: testRetry,
    // Starting a real MongoDB for the migration integration test is slower than any unit test here.
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // main.ts and migrate.ts are process entries: they read the environment, open connections and
      // either never return or exit, so they are covered by running them rather than by a unit test.
      exclude: ['src/**/*.test.ts', 'src/main.ts', 'src/migrate.ts'],
      thresholds: coverageFloor,
    },
  },
});
