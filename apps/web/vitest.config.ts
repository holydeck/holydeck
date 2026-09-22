import { defineConfig } from 'vitest/config';

import { coverageFloor, testRetry } from '../../vitest.base.js';

export default defineConfig({
  // The same automatic runtime the build compiles with, so a component under test is the component shipped.
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    // Node by default: most modules here are logic written against `*Like` interfaces, and several tests
    // read the shipped files through `import.meta.url`, which a DOM environment rewrites to an http URL.
    // A test that renders a component opts into a document with a `// @vitest-environment happy-dom`
    // comment at its top.
    environment: 'node',
    retry: testRetry,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      // The service worker entry delegates to the covered handlers and requires a worker context.
      exclude: ['src/**/*.test.{ts,tsx}', 'src/service-worker.ts'],
      thresholds: coverageFloor,
    },
  },
});
