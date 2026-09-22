// The stack the browser suite starts: the same services, with the application listening over HTTPS on a
// certificate made for the run. Graded here as well as used there, because a browser run that fails to
// start reports a timeout, not which half of the certificate the application never received.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { answers } from '../src/processes.js';
import { startStack } from '../src/stack.js';

import type { Stack } from '../src/stack.js';

describe.skipIf(spawnSync('openssl', ['version']).status !== 0)('a stack started to be reached over HTTPS', () => {
  let stack: Stack;

  beforeAll(async () => {
    stack = await startStack({ tls: true });
  });

  afterAll(async () => {
    await stack?.stop();
  });

  it('answers over HTTPS on the certificate it names, and not over plain HTTP', async () => {
    expect(stack.baseUrl.startsWith('https://127.0.0.1:')).toBe(true);
    expect(stack.certificateFile).toBeDefined();
    const ca = readFileSync(stack.certificateFile as string);

    expect(await answers(`${stack.baseUrl}/health`, ca)).toBe(true);
    expect(await answers(`${stack.baseUrl.replace(/^https/u, 'http')}/health`)).toBe(false);
  });
});
