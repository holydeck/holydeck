import { defineConfig } from 'vitest/config';

import { coverageFloor, testRetry } from '../../vitest.base.js';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    retry: testRetry,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // main.ts and health.ts are process entries: one reads the environment and parks, the other
      // reads a file and exits, so both are covered by running the worker rather than by a unit test.
      exclude: ['src/**/*.test.ts', 'src/main.ts', 'src/health.ts'],
      thresholds: coverageFloor,
    },
  },
});
