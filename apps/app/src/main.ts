import { randomBytes } from 'node:crypto';
import { constants, createReadStream, readFileSync, watch } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
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
import { conflictShelfOn } from './conflicts.js';
import { contentLanguagesOn } from './content-languages.js';
import { requestContext, systemContext } from './context.js';
import { probeCorpusIsClosed } from './corpus.js';
import { LIBRARY_PERMISSIONS, libraryOn } from './library.js';
import { serveLive } from './live.js';
import { liveTicketsOn } from './live-tickets.js';
import { liveHub } from './live-protocol.js';
import { themesOn } from './live-theme.js';
import { maintenanceDb, maintenanceOn } from './maintenance.js';
import { schemaStatus } from './migrations.js';
import { restoreCompatibilityDb, restoreCompatibilityOn } from './restore-compatibility.js';
import { mediaMigrationStateDb, mediaMigrationStateOn } from './media-migration-state.js';
import { mediaLibraryOn, mediaPurgeDb } from './media.js';
import { MID_SERVICE_PERMISSIONS, midServiceOn } from './mid-service-additions.js';
import { pptxCommitOn } from './pptx-commit.js';
import { pptxImportOn } from './pptx-import.js';
import { workerPptxRunner } from './pptx-isolated.js';
import { pptxReviewOn } from './pptx-review.js';
import { pptxSessionsOn } from './pptx-sessions.js';
import { queueDb, queueOn } from './queue.js';
import { redactingLogger, redactorFor, secretsIn } from './redaction.js';
import { notificationDb } from './notification-store.js';
import { repositoryDb } from './repositories.js';
import { REVISION_PERMISSIONS, revisionsOn } from './revisions.js';
import { deriveDeck } from './run-deck.js';
import { runEngineOn } from './run-engine.js';
import { runEventsOn } from './run-events.js';
import { runReviewOn } from './run-review.js';
import { runsOn } from './runs.js';
import { seedContext, seedOn } from './seed.js';
import { sermonsOn } from './sermons.js';
import { servicesOn } from './services.js';
import { serviceTemplatesOn } from './service-templates.js';
import { preparationOn } from './snapshots.js';
import { sessionDb, sessionsOn } from './sessions.js';
import { passkeyDb, passkeysOn } from './passkeys.js';
import { presenceDb, presenceOn } from './presence.js';
import { settingsAdminOn } from './settings-admin.js';
import { slideGroupsOn } from './slide-groups.js';
import { slideLayoutsOn } from './slide-layouts.js';
import { slideLabelsOn } from './slide-labels.js';
import { shownReferenceDb, shownReferencesOn } from './shown-references.js';
import { songsOn } from './songs.js';
import { songSingerChordsOn } from './song-singer-chords.js';
import { totpDb, totpsOn } from './totp.js';
import { translationOffsetDb, translationOffsetsOn } from './translation-offsets.js';
import { workspacePositionDb, workspacePositionsOn } from './workspace-positions.js';
import { loadSettings, settingsPath } from './settings.js';
import { readWebBuild } from './static.js';

import type { CapabilityStore } from './capabilities.js';
import type { ConflictShelf } from './conflicts.js';
import type { ContentLanguageStore } from './content-languages.js';
import type { LibraryStore } from './library.js';
import type { MaintenanceStore } from './maintenance.js';
import type { MediaByteSource } from './media-delivery-routes.js';
import type { MediaMigrationStateStore } from './media-migration-state.js';
import type { MediaLibrary, MediaLibraryOptions } from './media.js';
import type { MidServiceStore } from './mid-service-additions.js';
import type { Identity } from './onboarding.js';
import type { PptxCommit } from './pptx-commit.js';
import type { PptxImport } from './pptx-import.js';
import type { PptxReview } from './pptx-review.js';
import type { PptxSessionStore } from './pptx-sessions.js';
import type { PresenceStore } from './presence.js';
import type { Queue } from './queue.js';
import type { NotificationDb } from './notification-store.js';
import type { RepositoryDb } from './repositories.js';
import type { RestoreCompatibilityStore } from './restore-compatibility.js';
import type { RevisionStore } from './revisions.js';
import type { RunEventStore } from './run-events.js';
import type { RunReviewStore } from './run-review.js';
import type { SermonStore } from './sermons.js';
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
import type { SongStore } from './songs.js';
import type { SongSingerChordsStore } from './song-singer-chords.js';
import type { TranslationOffsetStore } from './translation-offsets.js';
import type { ThemeStore } from './live-theme.js';
import type { WorkspacePositionStore } from './workspace-positions.js';

checkReleasedContracts();

const newId = (): string => randomBytes(16).toString('base64url');

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
// Services are kept the same way, and a Guest's capability exchange reads this one to gate its join on
// the Presenting state (spec 9.3, T81): a deployment with nowhere to keep a Service has no state to gate on.
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
let mediaBytes: MediaByteSource | undefined;
let notificationDatabase: NotificationDb | undefined;
let backups: { readonly db: RepositoryDb; readonly queue: Queue } | undefined;
// The restore-apply lease is kept the same way: a deployment with nowhere to keep one has no worker
// applying a restore to it either, so `guardMaintenance` has nothing it could ever find held.
let maintenance: MaintenanceStore | undefined;
// Whether a restore was recently applied is kept the same way: a deployment with nowhere to keep one has
// no worker recording a restore against it either, so a session a restore ends is simply refused, the
// same as before this store existed.
let compatibility: RestoreCompatibilityStore | undefined;
// The last media storage-root migration is kept the same way: a deployment with nowhere to keep one has
// no worker migrating its media to a new root either, and its routes answer not-found the same way.
let migrationState: MediaMigrationStateStore | undefined;
// A translation's offset is kept the same way and for the same reason: a deployment with nowhere to
// keep one has none to read or configure, and its routes answer not-found the same way.
let translationOffsets: TranslationOffsetStore | undefined;
let workspacePositions: WorkspacePositionStore | undefined;
let contentExists: ((context: unknown, id: string) => Promise<boolean>) | undefined;
// What an operator showed is recorded the same way and for the same reason: a deployment with nowhere to
// write it down may show nothing, because a passage displayed without its revision recorded is the one
// thing BIBL-04 rules out, and its routes answer not-found the same way.
let shownReferences: ShownReferenceStore | undefined;
// Who is editing what is kept the same way and for the same reason: a deployment with nowhere to
// keep an entry has nobody here to observe, and its routes answer not-found the same way.
let presence: PresenceStore | undefined;
// Content history is kept the same way and for the same reason: a deployment with nowhere to keep
// one has no earlier revision to read, compare or bring back, and its routes answer not-found the
// same way.
let revisions: RevisionStore | undefined;
// The conflict shelf keeps a losing edit rather than discarding it (spec COLL-01), kept and administered
// the same way: a deployment with nowhere to keep one has nothing here to settle, and its routes answer
// not-found the same way.
let conflictShelf: ConflictShelf | undefined;
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
// A PowerPoint import's stores are kept the same way: a deployment with nowhere to keep an import
// session has none to upload, review or commit, and its routes answer not-found the same way.
let pptxImport: PptxImport | undefined;
let pptxReview: PptxReview | undefined;
let pptxCommit: PptxCommit | undefined;
let pptxSessions: PptxSessionStore | undefined;
let stopWatchingSettings: (() => void) | undefined;
if (settings.values.mongoUrl !== '') {
  store = new MongoClient(settings.values.mongoUrl, { ignoreUndefined: true });
  await store.connect();
  checkSchema(await schemaStatus(repositoryDb(store.db()), systemContext(`boot:${process.pid}`)));
  const now = (): string => new Date().toISOString();
  const queue = queueOn(queueDb(store.db()), { now });
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
  serviceTemplates = serviceTemplatesOn(repositoryDb(store.db()), { now, services });
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
  const bodies = revisionsOn(repositoryDb(store.db()), { now });
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
    return deriveDeck(deckContext, { slideGroups: groups, revisions: bodies }, snapshot, await additions.additions(deckContext, run.runId));
  };
  deck = deckFor;
  engine = runEngineOn({ hub, runs, runEvents, themes, midService, deck: deckFor, clock: now });
  slideLabels = slideLabelsOn(repositoryDb(store.db()), { now });
  slideLayouts = slideLayoutsOn(repositoryDb(store.db()), { now });
  revisions = revisionsOn(repositoryDb(store.db()), { now });
  conflictShelf = conflictShelfOn(repositoryDb(store.db()), { now });
  translationOffsets = translationOffsetsOn(translationOffsetDb(store.db()));
  workspacePositions = workspacePositionsOn(workspacePositionDb(store.db()), { now });
  const libraryStore = libraryOn(repositoryDb(store.db()), { now });
  library = libraryStore;
  contentExists = async (context, id) => (await libraryStore.get(context, id)) !== undefined;
  shownReferences = shownReferencesOn(shownReferenceDb(store.db()), { now });
  presence = presenceOn(presenceDb(store.db()), { now });
  songs = songsOn(repositoryDb(store.db()), { now });
  chords = songSingerChordsOn(repositoryDb(store.db()), { now });
  sermons = sermonsOn(repositoryDb(store.db()), { now });
  contentLanguages = contentLanguagesOn(repositoryDb(store.db()), { now });
  // First-run seed data (SEED-01): the records a fresh instance needs before any Admin has hand-built
  // a catalogue. Runs every boot, but is idempotent — see seed.ts's own header for how.
  await seedOn(repositoryDb(store.db()), { now }).run(seedContext(`boot:${process.pid}`));
  const mediaOptions: MediaLibraryOptions = {
    now,
    queue,
    // `settingsAdmin` is assigned later in this same block, but read lazily here: by the time this
    // getter is actually called, boot has long finished and a storage-root migration (OPS-16) may
    // have already rewritten `mediaRoot` — the live value, not the one read at construction, is
    // what every write and purge must see.
    mediaRoot: () => settingsAdmin?.current().values.mediaRoot ?? settings.values.mediaRoot,
    purge: mediaPurgeDb(store.db()),
    // The storageKey a write() hands back is bare — never root-prefixed — so a later storage-root
    // migration (OPS-16) leaves every asset uploaded under the old root still readable under the new
    // one. read()/remove() still accept an absolute key: the append-only architecture (ADR 0009)
    // forbids rewriting a storageKey already recorded, so an asset uploaded before this change keeps
    // its old absolute key forever, and resolving it against the live root would look in the wrong place.
    write: async (root, key, bytes) => {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, key), bytes);
      return key;
    },
    async read(root, key) {
      return new Uint8Array(await readFile(isAbsolute(key) ? key : join(root, key)));
    },
    // OPS-14: this asset's own bytes only. `serveMediaCleanupRoutes` below decides, from a live scan
    // of slide groups and reusable slides (`contentDb`), whether an asset is still referenced before
    // this ever runs — a song, reading, or sermon's own reference fields, once those schemas exist
    // (SONG-01, the sermon pipeline), are that task's to add to that scan, the same gap
    // retention-sweep-handler.ts already documents and defers for autosave-revision.
    async remove(root, key) {
      await rm(isAbsolute(key) ? key : join(root, key), { force: true });
    },
  };
  media = mediaLibraryOn(repositoryDb(store.db()), mediaOptions);
  mediaBytes = {
    // A storageKey is bare unless it predates the OPS-16 migration (see mediaOptions.write above), so
    // delivery resolves it against the live root exactly the way read()/remove() do.
    size: async (key) => (await stat(isAbsolute(key) ? key : join(mediaOptions.mediaRoot(), key))).size,
    stream: (key, range) => createReadStream(
      isAbsolute(key) ? key : join(mediaOptions.mediaRoot(), key),
      range === undefined ? {} : { start: range.start, end: range.end },
    ),
  };
  backups = { db: repositoryDb(store.db()), queue };
  notificationDatabase = notificationDb(store.db());
  maintenance = maintenanceOn(maintenanceDb(store.db()));
  compatibility = restoreCompatibilityOn(restoreCompatibilityDb(store.db()), { now });
  migrationState = mediaMigrationStateOn(mediaMigrationStateDb(store.db()));
  pptxImport = pptxImportOn(repositoryDb(store.db()), { ...mediaOptions, runner: workerPptxRunner() });
  pptxReview = pptxReviewOn(repositoryDb(store.db()), { now });
  pptxCommit = pptxCommitOn(repositoryDb(store.db()), { now, newId });
  pptxSessions = pptxSessionsOn(repositoryDb(store.db()), { now, newId });
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

// One ticket store, shared by the exchange routes that mint a socket ticket from a capability and the
// live socket that spends it (OUT-01): two stores would each refuse every ticket the other minted.
const liveTickets = capabilities === undefined ? undefined : liveTicketsOn(capabilities);

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
  compatibility,
  capabilities,
  liveTickets,
  settingsAdmin,
  slideLayouts,
  revisions,
  conflictShelf,
  media,
  mediaBytes,
  contentDb: backups?.db,
  backups,
  // The same driver `Db` `backups.db`/`contentDb` are `RepositoryDb` views of, narrowed differently
  // for OPS-09's own ping/stats reading (`operational-sources.ts`'s `MongoHealthDb`).
  mongoDb: store?.db(),
  notificationDb: notificationDatabase,
  maintenance,
  migrationState,
  translationOffsets,
  workspacePositions,
  contentExists,
  shownReferences,
  presence,
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
  songs,
  chords,
  sermons,
  slideGroups,
  library,
  contentLanguages,
  pptxImport,
  pptxReview,
  pptxCommit,
  pptxSessions,
  anthropicApiKey,
});

// The live socket is part of the surface this service serves, so it is registered before it listens.
//
// Guarded by a handshake ticket wherever a session can be held or a capability can be issued (spec 9.3,
// OUT-01) — a session's ticket is spent from a session opened by signing in; a Guest's or an output
// window's is minted by the exchange routes from a capability, and neither signs in to anything. The
// capability itself never reaches the socket: a URL that still carries one is refused and audited.
if (engine !== undefined) await engine.restore();
await serveLive(app, { hub, engine, sessions, capabilities, liveTickets, audit: identity?.audit });

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
