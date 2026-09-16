import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/output-profile.ts',
    'src/readiness.ts',
    'src/measure.ts',
    'src/auto-fit.ts',
    'src/render-model.ts',
    'src/renderer.ts',
    'src/surfaces.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // The offline presenter is the narrowest runtime this package has to work in, and nothing outside
  // `measure.ts`'s lazy puppeteer import is Node-only, so the layout half targets the browser too.
  target: 'es2023',
  external: ['puppeteer'],
});
