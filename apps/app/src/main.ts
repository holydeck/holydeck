import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MongoClient } from 'mongodb';

import { buildApp } from './app.js';
import {
  checkCorpusBoundary,
  checkCorpusIsClosed,
  checkReleasedContracts,
  checkSchema,
  readSettingsText,
} from './boot.js';
import { systemContext } from './context.js';
import { probeCorpusIsClosed } from './corpus.js';
import { serveLive } from './live.js';
import { schemaStatus } from './migrations.js';
import { repositoryDb } from './repositories.js';
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

// Durable records are optional until a deployment keeps any, and the presentation milestone keeps none.
// Where a store is configured, the schema it is at is graded before anything is served from it.
let store: MongoClient | undefined;
if (settings.values.mongoUrl !== '') {
  store = new MongoClient(settings.values.mongoUrl);
  await store.connect();
  checkSchema(await schemaStatus(repositoryDb(store.db()), systemContext(`boot:${process.pid}`)));
}

// Shipped in the same image as this service, at the same relative path the repository has.
const web = readWebBuild(fileURLToPath(new URL('../../web/dist/', import.meta.url)));

const app = buildApp({
  settings,
  logger: { level: process.env.HOLYDECK_LOG_LEVEL ?? 'info' },
  fetching: fetch,
  web,
});

// The live socket is part of the surface this service serves, so it is registered before it listens.
await serveLive(app);

for (const [key, source] of Object.entries(settings.sources)) {
  app.log.info(`${key} came from the ${source}`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => store?.close())
      .then(() => process.exit(0));
  });
}

// Containers reach the service through the published port, so the listener cannot be loopback-only.
await app.listen({ host: '0.0.0.0', port: settings.values.port });
