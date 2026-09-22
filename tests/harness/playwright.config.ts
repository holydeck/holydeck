// The browser suite: the three form factors the project promises to serve, each a real browser driving
// the real stack.
//
// Chromium only, deliberately: WebKit and Firefox coverage, and the runs on physical devices, are the
// open hardware question this milestone records rather than something a headless run can answer. The
// engine that is here is the one the stage display and the operator's laptop actually run.

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global.ts',
  // The stack is one process group shared by the whole run, so the run is serial: two workers driving
  // one application would grade each other's state instead of the client.
  workers: 1,
  fullyParallel: false,
  // A test that only passes on a retry is a test that found something; the run says so instead of
  // hiding it behind a green tick.
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI === undefined ? [['list']] : [['list'], ['github']],
  // The stack's certificate is made per run (e2e/global.ts), so no browser trusts it by name. Ignoring
  // the error per context is enough for pages and cookies, but Chromium still refuses to register a
  // service worker from an origin whose certificate it had to ignore unless the whole browser is told to.
  use: {
    trace: 'retain-on-failure',
    ignoreHTTPSErrors: true,
    launchOptions: { args: ['--ignore-certificate-errors'] },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', use: { ...devices['Galaxy Tab S4 landscape'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
});
