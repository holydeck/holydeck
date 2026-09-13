import { defineConfig } from 'vitest/config';

import { coverage100 } from '../../vitest.base.js';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // main.ts is the process entry: it reads argv and the environment, binds a port and never
      // returns, so it is covered by running the service rather than by a unit test.
      exclude: ['src/**/*.test.ts', 'src/main.ts'],
      thresholds: coverage100,
    },
  },
});
