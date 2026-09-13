import { defineConfig } from 'vitest/config';

import { coverage100 } from '../../vitest.base.js';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'integration/**/*.test.ts'],
    // The integration suite starts a MongoDB, a corpus, a migration, an application and a worker before
    // its first assertion, which is slower than any unit test in this repository.
    hookTimeout: 240_000,
    testTimeout: 30_000,
    // One stack at a time: the suite starts real processes on real ports, and two files racing to bind
    // them would fail for a reason that has nothing to do with the code under test.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: coverage100,
    },
  },
});
