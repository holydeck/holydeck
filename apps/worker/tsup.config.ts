import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/health.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: true,
});
