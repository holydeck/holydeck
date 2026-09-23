import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from 'vitest/config';

import { coverageFloor, testRetry } from '../../vitest.base.js';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    retry: testRetry,
    // Gives this run's own copy of backup-producer.ts's settings staging directory (see its
    // HOLYDECK_SETTINGS_STAGING_DIR doc comment), so a second `vitest run` of this suite happening on
    // the same machine at the same time — another CI job, a watch run left going, a manual re-run —
    // never races this one over the same OS tmp path.
    env: { HOLYDECK_SETTINGS_STAGING_DIR: join(tmpdir(), `holydeck-backup-settings-test-${process.pid}`) },
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
