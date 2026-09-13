// One stack for the whole browser run. Starting it per test would be honest and unusably slow; starting
// it per run and telling the workers where it is costs one address in the environment.

import { startStack } from '../src/stack.js';

import type { Stack } from '../src/stack.js';

export default async function globalSetup(): Promise<() => Promise<void>> {
  const stack: Stack = await startStack();
  // The name Playwright itself reads for `baseURL`, so every worker picks it up when it loads the
  // configuration in its own process.
  process.env.PLAYWRIGHT_TEST_BASE_URL = stack.baseUrl;
  return () => stack.stop();
}
