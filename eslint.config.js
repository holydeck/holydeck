import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain ESM scripts keep core no-undef, which typescript-eslint switches off for .ts; without the
    // Node globals it reports every URL and process as undefined.
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.nodeBuiltin },
  },
  {
    // docker-entrypoint-initdb.d runs these under mongosh, not Node: `db` is mongosh's own global for
    // the database it selected, reassigned here to switch databases, and mongosh exposes `process.env`
    // in the same shape Node does for reading the container's environment.
    files: ['deploy/mongo-init/**/*.js'],
    languageOptions: { globals: { ...globals.node, db: 'writable' } },
  },
);
