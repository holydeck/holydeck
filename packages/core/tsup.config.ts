import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/messages.ts', 'src/references.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node24',
});
