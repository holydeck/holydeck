import { defineConfig } from 'vitest/config';

import { coverageFloor, testRetry } from '../../vitest.base.js';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    retry: testRetry,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/cli.ts'],
      thresholds: coverageFloor,
    },
  },
});
