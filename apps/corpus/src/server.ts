import { readFileSync } from 'node:fs';
import { BrowserHttpClient } from '@holydeck/core/browser-fetch';
import { Fetcher } from '@holydeck/core/fetcher';
import { createPuppeteerLauncher } from '@holydeck/core/puppeteer-launcher';
import { MongoClient } from 'mongodb';
import { buildApp } from './app.js';
import { resolveServerConfig } from './config.js';
import { SyncJobManager } from './jobs.js';
import { MongoStore } from './mongo-store.js';

const config = resolveServerConfig();
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const client = new MongoClient(config.mongoUrl);
await client.connect();
const db = client.db(config.mongoDb);

const store = new MongoStore(db);

// Containers have no sandbox namespaces and a small default /dev/shm; both flags are needed
// for Chromium to start under the image's unprivileged user.
const browser = config.browserFetch
  ? new BrowserHttpClient({
      launch: createPuppeteerLauncher({
        ...(config.browserExecutablePath === undefined ? {} : { executablePath: config.browserExecutablePath }),
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      }),
    })
  : undefined;
const fetcher = new Fetcher(browser === undefined ? {} : { httpGet: browser.httpGet });
const jobs = new SyncJobManager(store, fetcher, db, {
  concurrency: config.syncConcurrency,
  delayMs: config.syncDelayMs,
});

const app = buildApp({ store, fetcher, jobs, version, logger: { level: config.logLevel } });

const recovered = await jobs.recoverInterrupted();
if (recovered > 0) {
  app.log.warn(`marked ${recovered} interrupted sync job(s) as failed after restart`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => browser?.close())
      .then(() => client.close())
      .then(() => process.exit(0));
  });
}

await app.listen({ host: config.host, port: config.port });
