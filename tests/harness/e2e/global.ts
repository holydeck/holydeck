// One stack for the whole browser run. Starting it per test would be honest and unusably slow; starting
// it per run and telling the workers where it is costs one address in the environment.
//
// The stack speaks HTTPS: the session cookie is `Secure`, and signing in through the page is what this
// suite grades. The browser is told to accept the run's own certificate (playwright.config.ts); a Node
// request a spec makes trusts it through `NODE_EXTRA_CA_CERTS`, which each worker reads as it starts.

import { startStack } from '../src/stack.js';

import type { Stack } from '../src/stack.js';

export default async function globalSetup(): Promise<() => Promise<void>> {
  const stack: Stack = await startStack({ tls: true });
  // The name Playwright itself reads for `baseURL`, so every worker picks it up when it loads the
  // configuration in its own process.
  process.env.PLAYWRIGHT_TEST_BASE_URL = stack.baseUrl;
  if (stack.certificateFile !== undefined) process.env.NODE_EXTRA_CA_CERTS = stack.certificateFile;
  return () => stack.stop();
}
