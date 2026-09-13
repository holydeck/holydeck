import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/locales.ts', 'src/format.ts', 'src/messages.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // Every client renders copy, and the browser is the narrowest runtime among them; the browser-safety
  // gate in scripts/workspace keeps this source free of anything Node-only.
  target: 'es2023',
});
