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
import { redactingLogger, redactorFor, secretsIn } from './redaction.js';
import { repositoryDb } from './repositories.js';
import { sessionDb, sessionsOn } from './sessions.js';
import { loadSettings, settingsPath } from './settings.js';
import { readWebBuild } from './static.js';

import type { SessionStore } from './sessions.js';

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
// A session is a durable record, so a deployment that keeps none keeps no sessions either, and refuses
// every request that would change something rather than accepting one it cannot prove.
let sessions: SessionStore | undefined;
if (settings.values.mongoUrl !== '') {
  store = new MongoClient(settings.values.mongoUrl);
  await store.connect();
  checkSchema(await schemaStatus(repositoryDb(store.db()), systemContext(`boot:${process.pid}`)));
  sessions = sessionsOn(sessionDb(store.db()), { now: () => new Date().toISOString() });
}

// Shipped in the same image as this service, at the same relative path the repository has.
const web = readWebBuild(fileURLToPath(new URL('../../web/dist/', import.meta.url)));

const app = buildApp({
  settings,
  // Every secret this deployment was configured with is replaced wherever it appears in a log line: a
  // connection string reaches a log through an error message far more often than through a log call.
  logger: redactingLogger(process.env.HOLYDECK_LOG_LEVEL ?? 'info', redactorFor(secretsIn(settings.values))),
  fetching: fetch,
  web,
  sessions,
});

// The live socket is part of the surface this service serves, so it is registered before it listens.
//
// Served without a handshake ticket for as long as this build has no way to sign in: a ticket comes from
// a session, a session comes from signing in, and a guard on a deployment nothing can hold a session in
// refuses every client there is, including the only one this repository ships. The guard itself is built
// and proven; `serveLive(app, { sessions })` is the one line that turns it on, and the release that adds
// account sign-in adds it.
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
