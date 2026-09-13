import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildApp } from './app.js';
import { checkCorpusBoundary, checkCorpusIsClosed, checkReleasedContracts, readSettingsText } from './boot.js';
import { probeCorpusIsClosed } from './corpus.js';
import { loadSettings, settingsPath } from './settings.js';
import { readWebBuild } from './static.js';

checkReleasedContracts();

const path = settingsPath(process.env);
const settings = loadSettings({
  fileText: readSettingsText((file) => readFileSync(file, 'utf8'), path),
  env: process.env,
  path,
});

const corpus = { url: settings.values.corpusUrl, token: settings.values.corpusToken };
checkCorpusBoundary(corpus);
// Asked once, before serving: a corpus that answers an unauthenticated request is reachable by
// anything else that can reach it too, and that is not a deployment to start serving through.
checkCorpusIsClosed(await probeCorpusIsClosed(corpus, fetch));

// Shipped in the same image as this service, at the same relative path the repository has.
const web = readWebBuild(fileURLToPath(new URL('../../web/dist/', import.meta.url)));

const app = buildApp({
  settings,
  logger: { level: process.env.HOLYDECK_LOG_LEVEL ?? 'info' },
  fetching: fetch,
  web,
});

for (const [key, source] of Object.entries(settings.sources)) {
  app.log.info(`${key} came from the ${source}`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

// Containers reach the service through the published port, so the listener cannot be loopback-only.
await app.listen({ host: '0.0.0.0', port: settings.values.port });
