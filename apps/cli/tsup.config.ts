import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'node24',
  noExternal: [/./],
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __holydeckCreateRequire } from 'node:module';\nconst require = __holydeckCreateRequire(import.meta.url);",
  },
});
