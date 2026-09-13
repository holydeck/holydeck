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
);
