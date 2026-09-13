import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/health.ts', 'src/jobs.ts', 'src/runner.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  // Only the one module anything imports carries types; the entry points are run, not imported.
  dts: { entry: ['src/jobs.ts', 'src/runner.ts'] },
  sourcemap: true,
  clean: true,
});
