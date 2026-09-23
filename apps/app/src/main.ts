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
import { contentLanguagesOn } from './content-languages.js';
import { systemContext } from './context.js';
import { probeCorpusIsClosed } from './corpus.js';
import { libraryOn } from './library.js';
import { serveLive } from './live.js';
import { schemaStatus } from './migrations.js';
import { mediaLibraryOn } from './media.js';
import { queueDb, queueOn } from './queue.js';
import { redactingLogger, redactorFor, secretsIn } from './redaction.js';
import { repositoryDb } from './repositories.js';
import { seedContext, seedOn } from './seed.js';
import { sermonsOn } from './sermons.js';
import { servicesOn } from './services.js';
import { serviceTemplatesOn } from './service-templates.js';
import { preparationOn } from './snapshots.js';
import { sessionDb, sessionsOn } from './sessions.js';
import { passkeyDb, passkeysOn } from './passkeys.js';
import { settingsAdminOn } from './settings-admin.js';
import { slideGroupsOn } from './slide-groups.js';
import { slideLayoutsOn } from './slide-layouts.js';
import { slideLabelsOn } from './slide-labels.js';
import { shownReferenceDb, shownReferencesOn } from './shown-references.js';
import { songsOn } from './songs.js';
import { songSingerChordsOn } from './song-singer-chords.js';
import { totpDb, totpsOn } from './totp.js';
import { translationOffsetDb, translationOffsetsOn } from './translation-offsets.js';
import { loadSettings, settingsPath } from './settings.js';
import { readWebBuild } from './static.js';

import type { CapabilityStore } from './capabilities.js';
import type { ContentLanguageStore } from './content-languages.js';
import type { LibraryStore } from './library.js';
import type { MediaLibrary } from './media.js';
import type { Identity } from './onboarding.js';
import type { SermonStore } from './sermons.js';
import type { ServiceStore } from './services.js';
import type { ServiceTemplateStore } from './service-templates.js';
import type { PreparationStore } from './snapshots.js';
import type { SettingsAdmin } from './settings-admin.js';
import type { SlideGroupStore } from './slide-groups.js';
import type { SlideLayoutStore } from './slide-layouts.js';
import type { SlideLabelStore } from './slide-labels.js';
import type { SessionStore } from './sessions.js';
import type { ShownReferenceStore } from './shown-references.js';
import type { SongStore } from './songs.js';
import type { SongSingerChordsStore } from './song-singer-chords.js';
import type { TranslationOffsetStore } from './translation-offsets.js';

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
// Songs, Sermons and Slide Groups are durable content records too, kept and administered the same way: a
// deployment with nowhere to keep one has none to create, edit or generate slides from, and its routes
// answer not-found the same way.
let songs: SongStore | undefined;
let chords: SongSingerChordsStore | undefined;
let sermons: SermonStore | undefined;
let slideGroups: SlideGroupStore | undefined;
// Every Song and Sermon indexed together, read from the same store either was written to: a deployment
// with nowhere to keep either has nothing here to list.
let library: LibraryStore | undefined;
// The content-language registry is kept the same way and for the same reason: a deployment with nowhere
// to keep one has none to create, edit or archive, and its routes answer not-found the same way.
let contentLanguages: ContentLanguageStore | undefined;
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
  slideLabels = slideLabelsOn(repositoryDb(store.db()), { now });
  slideLayouts = slideLayoutsOn(repositoryDb(store.db()), { now });
  translationOffsets = translationOffsetsOn(translationOffsetDb(store.db()));
  shownReferences = shownReferencesOn(shownReferenceDb(store.db()), { now });
  songs = songsOn(repositoryDb(store.db()), { now });
  chords = songSingerChordsOn(repositoryDb(store.db()), { now });
  sermons = sermonsOn(repositoryDb(store.db()), { now });
  slideGroups = slideGroupsOn(repositoryDb(store.db()), { now });
  library = libraryOn(repositoryDb(store.db()), { now });
  contentLanguages = contentLanguagesOn(repositoryDb(store.db()), { now });
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

// Read bare, never through settings.ts: a deployment without this key simply has no resolver, and the
// key itself is never worth persisting to the settings file it would then have to be redacted out of.
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

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
  slideLabels,
  songs,
  chords,
  sermons,
  slideGroups,
  library,
  contentLanguages,
  anthropicApiKey,
});

// The live socket is part of the surface this service serves, so it is registered before it listens.
//
// Guarded by a handshake ticket wherever a session can be held, or a Guest capability wherever one can
// be issued (spec 9.3, T81) — a ticket is spent from a session and a session is opened by signing in; a
// capability is redeemed against a Service left Presenting, and a Guest signs in to nothing at all. A
// deployment that keeps no durable records has neither to hand the guard, and its socket refuses every
// client there is — which is the same answer as before, reached now because there is nothing to sign in
// to or be invited into, rather than no way to sign in.
await serveLive(app, { sessions, capabilities, services });

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
