import { defineConfig } from 'vitest/config';

import { coverage100 } from '../../vitest.base.js';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Two entry files are excluded: both are wiring that only a real browser can execute, and both
      // delegate immediately to the handlers below, which are covered.
      exclude: ['src/**/*.test.ts', 'src/main.ts', 'src/service-worker.ts'],
      thresholds: coverage100,
    },
  },
});
