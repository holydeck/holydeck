import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/messages.ts', 'src/references.ts', 'src/translations.ts', 'src/canon.ts', 'src/config.ts', 'src/sermon.ts', 'src/template.ts', 'src/storage.ts', 'src/file-store.ts', 'src/scraper.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node24',
});
