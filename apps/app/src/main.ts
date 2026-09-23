import { constants, readFileSync, watch } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  checkOwnSettingsMount,
  checkReleasedContracts,
  checkSchema,
  readSettingsText,
} from './boot.js';
import { requestContext, systemContext } from './context.js';
import { probeCorpusIsClosed } from './corpus.js';
import { LIBRARY_PERMISSIONS } from './library.js';
import { serveLive } from './live.js';
import { liveHub } from './live-protocol.js';
import { themesOn } from './live-theme.js';
import { schemaStatus } from './migrations.js';
import { mediaLibraryOn } from './media.js';
import { MID_SERVICE_PERMISSIONS, midServiceOn } from './mid-service-additions.js';
import { queueDb, queueOn } from './queue.js';
import { redactingLogger, redactorFor, secretsIn } from './redaction.js';
import { repositoryDb } from './repositories.js';
import { REVISION_PERMISSIONS } from './revisions.js';
import { deriveDeck } from './run-deck.js';
import { runEngineOn } from './run-engine.js';
import { runEventsOn } from './run-events.js';
import { runReviewOn } from './run-review.js';
import { runsOn } from './runs.js';
import { seedContext, seedOn } from './seed.js';
import { servicesOn } from './services.js';
import { serviceTemplatesOn } from './service-templates.js';
import { preparationOn } from './snapshots.js';
import { sessionDb, sessionsOn } from './sessions.js';
import { passkeyDb, passkeysOn } from './passkeys.js';
import { settingsAdminOn } from './settings-admin.js';
import { slideLayoutsOn } from './slide-layouts.js';
import { slideGroupsOn } from './slide-groups.js';
import { slideLabelsOn } from './slide-labels.js';
import { shownReferenceDb, shownReferencesOn } from './shown-references.js';
import { totpDb, totpsOn } from './totp.js';
import { translationOffsetDb, translationOffsetsOn } from './translation-offsets.js';
import { loadSettings, settingsPath } from './settings.js';
import { readWebBuild } from './static.js';

import type { CapabilityStore } from './capabilities.js';
import type { MediaLibrary } from './media.js';
import type { MidServiceStore } from './mid-service-additions.js';
import type { Identity } from './onboarding.js';
import type { RunEventStore } from './run-events.js';
import type { RunReviewStore } from './run-review.js';
import type { ServiceStore } from './services.js';
import type { ServiceTemplateStore } from './service-templates.js';
import type { RequestContext } from './context.js';
import type { RunDeck } from './run-deck.js';
import type { RunEngine } from './run-engine.js';
import type { SlideGroupStore } from './slide-groups.js';
import type { RunRecord, RunStore } from './runs.js';
import type { PreparationStore } from './snapshots.js';
import type { SettingsAdmin } from './settings-admin.js';
import type { SlideLayoutStore } from './slide-layouts.js';
import type { SlideLabelStore } from './slide-labels.js';
import type { SessionStore } from './sessions.js';
import type { ShownReferenceStore } from './shown-references.js';
import type { TranslationOffsetStore } from './translation-offsets.js';
import type { ThemeStore } from './live-theme.js';

checkReleasedContracts();

const path = settingsPath(process.env);
checkOwnSettingsMount(path);
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

// Built here, not inside `serveLive`, because a later task's run engine publishes through the same hub
// from outside the live socket entirely (Design §1) — the hub is a piece of this deployment's own state,
// not a detail of how a connection to it is served. Kept unconditional, unlike the durable stores above:
// a deployment with nowhere to keep a run still serves a live socket, watch-only, the same way it always
// has (see the comment on `serveLive` below).
const hub = liveHub({ clock: () => new Date().toISOString() });

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
// Services are kept the same way, and the live socket reads this one to gate a Guest's join on the
// Presenting state (spec 9.3, T81): a deployment with nowhere to keep a Service has no state to gate on.
let services: ServiceStore | undefined;
let serviceTemplates: ServiceTemplateStore | undefined;
let preparation: PreparationStore | undefined;
// A run's own row is kept the same way, for the same reason: a deployment with nowhere to keep one
// cannot start, end or resume it, and its routes answer not-found the same way.
let runs: RunStore | undefined;
let runEvents: RunEventStore | undefined;
// Constructed once here (RUN-08) rather than inside midServiceOn/live-theme.ts/run-review.ts
// themselves, so every caller in this deployment shares one instance over the same database instead of
// each building its own — the same reason every other durable store in this file is built once, here.
let themes: ThemeStore | undefined;
let runReview: RunReviewStore | undefined;
let midService: MidServiceStore | undefined;
let slideGroups: SlideGroupStore | undefined;
let engine: RunEngine | undefined;
let deck: ((context: unknown, run: RunRecord) => Promise<RunDeck>) | undefined;
let slideLabels: SlideLabelStore | undefined;
// The settings admin is kept apart from the durable store, but wired up alongside it: a deployment with
// nowhere to keep accounts has nobody who could administer settings either, and its route answers
// not-found the same way the others do.
let settingsAdmin: SettingsAdmin | undefined;
// Slide Layouts are durable records too, and administered by the same Admin: a deployment with nowhere to
// keep one has none to create, version or archive, and its routes answer not-found the same way.
let slideLayouts: SlideLayoutStore | undefined;
// The media library is kept the same way and administered by the same Admin: a deployment with nowhere to
// keep one has nothing here to upload to, and its route answers not-found the same way.
let media: MediaLibrary | undefined;
// A translation's offset is kept the same way and for the same reason: a deployment with nowhere to
// keep one has none to read or configure, and its routes answer not-found the same way.
let translationOffsets: TranslationOffsetStore | undefined;
// What an operator showed is recorded the same way and for the same reason: a deployment with nowhere to
// write it down may show nothing, because a passage displayed without its revision recorded is the one
// thing BIBL-04 rules out, and its routes answer not-found the same way.
let shownReferences: ShownReferenceStore | undefined;
let stopWatchingSettings: (() => void) | undefined;
if (settings.values.mongoUrl !== '') {
  store = new MongoClient(settings.values.mongoUrl, { ignoreUndefined: true });
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
  services = servicesOn(repositoryDb(store.db()), { now });
  serviceTemplates = serviceTemplatesOn(repositoryDb(store.db()), { now });
  preparation = preparationOn(repositoryDb(store.db()), { now });
  runs = runsOn(repositoryDb(store.db()), { now });
  runEvents = runEventsOn(repositoryDb(store.db()), { now });
  themes = themesOn(runEvents);
  runReview = runReviewOn(runEvents);
  midService = midServiceOn(repositoryDb(store.db()), { now, runs, runEvents });
  slideGroups = slideGroupsOn(repositoryDb(store.db()), { now });
  const manifests = preparation;
  const additions = midService;
  const groups = slideGroups;
  const deckFor = async (context: unknown, run: RunRecord): Promise<RunDeck> => {
    const held = context as RequestContext;
    const deckContext = requestContext({
      ...held,
      permissions: [...new Set([
        ...held.permissions,
        LIBRARY_PERMISSIONS.read,
        REVISION_PERMISSIONS.read,
        MID_SERVICE_PERMISSIONS.read,
      ])],
    });
    const snapshot = await manifests.snapshot(deckContext, run.snapshotId);
    if (snapshot === undefined) throw new Error(`${run.snapshotId} is not a manifest this server holds`);
    return deriveDeck(deckContext, { slideGroups: groups }, snapshot, await additions.additions(deckContext, run.runId));
  };
  deck = deckFor;
  engine = runEngineOn({ hub, runs, runEvents, themes, midService, deck: deckFor, clock: now });
  slideLabels = slideLabelsOn(repositoryDb(store.db()), { now });
  slideLayouts = slideLayoutsOn(repositoryDb(store.db()), { now });
  translationOffsets = translationOffsetsOn(translationOffsetDb(store.db()));
  shownReferences = shownReferencesOn(shownReferenceDb(store.db()), { now });
  // First-run seed data (SEED-01): the records a fresh instance needs before any Admin has hand-built
  // a catalogue. Runs every boot, but is idempotent — see seed.ts's own header for how.
  await seedOn(repositoryDb(store.db()), { now }).run(seedContext(`boot:${process.pid}`));
  media = mediaLibraryOn(repositoryDb(store.db()), {
    now,
    queue: queueOn(queueDb(store.db()), { now }),
    mediaRoot: settings.values.mediaRoot,
    write: async (root, key, bytes) => {
      await mkdir(root, { recursive: true });
      const path = join(root, key);
      await writeFile(path, bytes);
      return path;
    },
    async read(_root, key) {
      return new Uint8Array(await readFile(key));
    },
  });
  settingsAdmin = settingsAdminOn(settings, {
    readFile: (path) => readFile(path, 'utf8'),
    writeFile,
    rename,
    watch,
    writable: async (path) => {
      try {
        await access(path, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    env: process.env,
  });
  const watcher = settingsAdmin.watch();
  stopWatchingSettings = () => watcher.close();
}

// Shipped in the same image as this service, at the same relative path the repository has.
const web = readWebBuild(fileURLToPath(new URL('../../web/dist/', import.meta.url)));

// Both or neither is already enforced by the settings loader; reading here fails start-up loudly on a path that is not a readable file.
const https = settings.values.tlsCertFile === ''
  ? undefined
  : { cert: readFileSync(settings.values.tlsCertFile), key: readFileSync(settings.values.tlsKeyFile) };

const app = buildApp({
  settings,
  // Every secret this deployment was configured with is replaced wherever it appears in a log line: a
  // connection string reaches a log through an error message far more often than through a log call.
  logger: redactingLogger(process.env.HOLYDECK_LOG_LEVEL ?? 'info', redactorFor(secretsIn(settings.values))),
  https,
  fetching: fetch,
  web,
  sessions,
  identity,
  capabilities,
  settingsAdmin,
  slideLayouts,
  media,
  translationOffsets,
  shownReferences,
  services,
  serviceTemplates,
  preparation,
  runs,
  themes,
  runReview,
  runEngine: engine,
  deck,
  midService,
  slideLabels,
});

// The live socket is part of the surface this service serves, so it is registered before it listens.
//
// Guarded by a handshake ticket wherever a session can be held, or a Guest capability wherever one can
// be issued (spec 9.3, T81) — a ticket is spent from a session and a session is opened by signing in; a
// capability is redeemed against a Service left Presenting, and a Guest signs in to nothing at all. A
// deployment that keeps no durable records has neither to hand the guard, and its socket refuses every
// client there is — which is the same answer as before, reached now because there is nothing to sign in
// to or be invited into, rather than no way to sign in.
if (engine !== undefined) await engine.restore();
await serveLive(app, { hub, engine, sessions, capabilities, services });

for (const [key, source] of Object.entries(settings.sources)) {
  app.log.info(`${key} came from the ${source}`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopWatchingSettings?.();
    void app
      .close()
      .then(() => store?.close())
      .then(() => process.exit(0));
  });
}

// Containers reach the service through the published port, so the listener cannot be loopback-only.
await app.listen({ host: '0.0.0.0', port: settings.values.port });
