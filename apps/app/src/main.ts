import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MongoClient } from 'mongodb';

import { accountDb, accountsOn } from './accounts.js';
import { buildApp } from './app.js';
import { attemptDb, attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { capabilityDb, capabilitiesOn } from './capabilities.js';
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
import { passkeyDb, passkeysOn } from './passkeys.js';
import { totpDb, totpsOn } from './totp.js';
import { loadSettings, settingsPath } from './settings.js';
import { readWebBuild } from './static.js';

import type { CapabilityStore } from './capabilities.js';
import type { Identity } from './onboarding.js';
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
// Accounts are kept the same way and for the same reason: a deployment with nowhere to put one cannot be
// claimed, and its onboarding route answers not-found from the first request rather than from the second.
let identity: Identity | undefined;
// Capabilities are kept the same way and for the same reason: a deployment with nowhere to put one has
// no guest invitation and no output capability to issue, and its route answers not-found instead.
let capabilities: CapabilityStore | undefined;
if (settings.values.mongoUrl !== '') {
  store = new MongoClient(settings.values.mongoUrl);
  await store.connect();
  checkSchema(await schemaStatus(repositoryDb(store.db()), systemContext(`boot:${process.pid}`)));
  const now = (): string => new Date().toISOString();
  sessions = sessionsOn(sessionDb(store.db()), { now });
  identity = {
    accounts: accountsOn(accountDb(store.db()), { now }),
    audit: auditOn(repositoryDb(store.db()), { now }),
    attempts: attemptsOn(attemptDb(store.db()), { now }),
    totp: totpsOn(totpDb(store.db()), { now }),
    passkeys: passkeysOn(passkeyDb(store.db()), { now }),
  };
  capabilities = capabilitiesOn(capabilityDb(store.db()), { now });
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
  identity,
  capabilities,
});

// The live socket is part of the surface this service serves, so it is registered before it listens.
//
// Guarded by a handshake ticket wherever a session can be held: a ticket is spent from a session, and a
// session is opened by signing in. A deployment that keeps no durable records has no sessions to hand the
// guard, so it has no tickets either, and its socket refuses every client there is — which is the same
// answer as before, reached now because there is nothing to sign in to rather than no way to sign in.
await serveLive(app, { sessions });

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
