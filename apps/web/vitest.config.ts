import { defineConfig } from 'vitest/config';

import { coverageFloor, testRetry } from '../../vitest.base.js';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    retry: testRetry,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The service worker entry delegates to the covered handlers and requires a worker context.
      exclude: ['src/**/*.test.ts', 'src/service-worker.ts'],
      thresholds: coverageFloor,
    },
  },
});
