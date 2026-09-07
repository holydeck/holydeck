import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/messages.ts', 'src/references.ts', 'src/translations.ts', 'src/canon.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node24',
});
