import { expect, it } from 'vitest';
import { CLI_VERSION } from './version.js';

it('is the unreleased placeholder version until Phase 4 wires releases', () => {
  expect(CLI_VERSION).toBe('0.0.0');
});
