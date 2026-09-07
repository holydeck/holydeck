import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/messages.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node22',
});
