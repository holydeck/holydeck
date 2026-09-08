import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/messages.ts', 'src/references.ts', 'src/translations.ts', 'src/canon.ts', 'src/config.ts', 'src/sermon.ts', 'src/template.ts', 'src/storage.ts', 'src/file-store.ts', 'src/scraper.ts', 'src/fetcher.ts', 'src/browser-fetch.ts', 'src/puppeteer-launcher.ts', 'src/sync.ts', 'src/assemble.ts', 'src/fetch-missing.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node24',
  external: ['puppeteer'],
});
