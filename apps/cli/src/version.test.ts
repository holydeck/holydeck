import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CLI_VERSION } from './version.js';

it('matches the package manifest version', () => {
  const { version } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  expect(CLI_VERSION).toBe(version);
});
