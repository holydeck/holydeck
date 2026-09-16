import { defineConfig } from 'vitest/config';

import { coverageFloor, testRetry } from '../../vitest.base.js';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    retry: testRetry,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Two entry files are excluded: both are wiring that only a real browser can execute, and both
      // delegate immediately to the handlers below, which are covered.
      exclude: ['src/**/*.test.ts', 'src/main.ts', 'src/service-worker.ts'],
      thresholds: coverageFloor,
    },
  },
});
