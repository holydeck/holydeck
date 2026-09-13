import { defineConfig } from 'vitest/config';

import { coverage100 } from '../../vitest.base.js';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // main.ts is the process entry: it reads the environment and parks, so it is covered by
      // running the worker rather than by a unit test.
      exclude: ['src/**/*.test.ts', 'src/main.ts'],
      thresholds: coverage100,
    },
  },
});
