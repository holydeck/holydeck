import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/accounts.ts',
    'src/canonical.ts',
    'src/problems.ts',
    'src/http.ts',
    'src/clients.ts',
    'src/corpus.ts',
    'src/live.ts',
    'src/jobs.ts',
    'src/entities.ts',
    'src/portable.ts',
    'src/revisions.ts',
    'src/sessions.ts',
    'src/snapshots.ts',
    'src/services.ts',
    'src/totp.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // The browser is the narrowest runtime the contracts have to work in, and the browser-safety gate
  // in scripts/workspace keeps the source free of anything Node-only, so nothing here needs node24.
  target: 'es2023',
});
