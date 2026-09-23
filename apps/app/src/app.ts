import { CLIENT_VERSION_HEADER, CLIENT_WINDOW, decideClient, supportedClientVersions } from '@holydeck/contracts/clients';
import { MESSAGE_CODES, errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import { serveAccountRoutes } from './accounts-routes.js';
import { serveAuditRoutes } from './audit-routes.js';
import { enforceAuthorization } from './authorization.js';
import { serveBackupRoutes } from './backup-routes.js';
import { serveCapabilityRoutes } from './capability-routes.js';
import { serveConflictRoutes } from './conflict-routes.js';
import { contentKindResolver } from './content-kind.js';
import { serveContentLanguageRoutes } from './content-language-routes.js';
import { REFERENCE_MALFORMED, corpusClient, referenceFrom, selectReference } from './corpus.js';
import { guardMutations } from './csrf.js';
import { notFound, withSafeErrors } from './failures.js';
import { serveIntegrationRoutes, sermonAiSwitch } from './integration-routes.js';
import { serveJobRoutes } from './job-routes.js';
import { serveLibraryRoutes } from './library-routes.js';
import { isUpgrade } from './live.js';
import { guardMaintenance } from './maintenance.js';
import { serveMediaCleanupRoutes } from './media-cleanup-routes.js';
import { serveMediaDeliveryRoutes } from './media-delivery-routes.js';
import { serveMediaMigrationRoutes } from './media-migration-routes.js';
import { serveMediaRoutes } from './media-routes.js';
import { serveNotificationRoutes } from './notification-routes.js';
import { notificationStoreOn } from './notification-store.js';
import { repositoriesOn } from './repositories.js';
import { serveOnboarding } from './onboarding.js';
import { serveOperationsRoutes } from './operations-routes.js';
import { serveOrderRoutes } from './order-routes.js';
import { serveOutputDefaultsRoutes } from './output-defaults-routes.js';
import { servePasskeyRoutes } from './passkey-routes.js';
import { servePptxRoutes } from './pptx-routes.js';
import { servePresenceRoutes } from './presence-routes.js';
import { servePreparationRoutes } from './preparation-routes.js';
import { serveReferenceRoutes } from './reference-routes.js';
import { serveRestoreRoutes } from './restore-routes.js';
import { serveRevisionRoutes } from './revision-routes.js';
import { serveRunRoutes } from './run-routes.js';
import { serveScriptureSearchRoutes } from './scripture-routes.js';
import { serveSermonRoutes } from './sermon-routes.js';
import { serveServiceRoutes } from './service-routes.js';
import { serveServiceTemplateRoutes } from './service-template-routes.js';
import { serveSessionRoutes } from './session-routes.js';
import { serveSettingsRoutes } from './settings-routes.js';
import { serveSlideGroupRoutes } from './slide-group-routes.js';
import { serveSlideLabelRoutes } from './slide-label-routes.js';
import { serveSlideLayoutRoutes } from './slide-layout-routes.js';
import { serveSongRoutes } from './song-routes.js';
import { serveTotpRoutes } from './totp-routes.js';
import { serveTranslationOffsetRoutes } from './translation-offset-routes.js';
import { serveWebClient, shellFallback, withSecurityHeaders } from './static.js';
import { serveWorkspacePositionRoutes } from './workspace-position-routes.js';

import type { RouteNeed } from './authorization.js';
import type { CapabilityStore } from './capabilities.js';
import type { ConflictShelf } from './conflicts.js';
import type { ContentLanguageStore } from './content-languages.js';
import type { Fetching } from './corpus.js';
import type { LibraryStore } from './library.js';
import type { MaintenanceStore } from './maintenance.js';
import type { MediaByteSource } from './media-delivery-routes.js';
import type { MediaMigrationStateStore } from './media-migration-state.js';
import type { MediaLibrary } from './media.js';
import type { MidServiceStore } from './mid-service-additions.js';
import type { NotificationDb } from './notification-store.js';
import type { Identity } from './onboarding.js';
import type { MongoHealthDb } from './operational-sources.js';
import type { PptxCommit } from './pptx-commit.js';
import type { PptxImport } from './pptx-import.js';
import type { PptxReview } from './pptx-review.js';
import type { PptxSessionStore } from './pptx-sessions.js';
import type { PresenceStore } from './presence.js';
import type { Queue } from './queue.js';
import type { RepositoryDb } from './repositories.js';
import type { RestoreCompatibility } from './csrf.js';
import type { RevisionStore } from './revisions.js';
import type { RunDeck } from './run-deck.js';
import type { RunEngine } from './run-engine.js';
import type { RunReviewStore } from './run-review.js';
import type { RunRecord, RunStore } from './runs.js';
import type { SermonStore } from './sermons.js';
import type { ServiceStore } from './services.js';
import type { ServiceTemplateStore } from './service-templates.js';
import type { PreparationStore } from './snapshots.js';
import type { SlideGroupStore } from './slide-groups.js';
import type { SlideLabelStore } from './slide-labels.js';
import type { SettingsAdmin } from './settings-admin.js';
import type { SlideLayoutStore } from './slide-layouts.js';
import type { SessionStore } from './sessions.js';
import type { LoadedSettings } from './settings.js';
import type { ShownReferenceStore } from './shown-references.js';
import type { SongStore } from './songs.js';
import type { SongSingerChordsStore } from './song-singer-chords.js';
import type { TranslationOffsetStore } from './translation-offsets.js';
import type { ThemeStore } from './live-theme.js';
import type { WebAsset } from './static.js';
import type { WorkspacePositionStore } from './workspace-positions.js';

const PUBLIC: RouteNeed = { kind: 'public' };

export interface AppOptions {
  settings: LoadedSettings;
  /** Explicit rather than defaulted: a service that silently stops logging is hard to notice. */
  logger: FastifyServerOptions['logger'];
  /** A certificate and key to answer HTTPS with; absent for plain HTTP behind a terminating proxy. */
  https?: { readonly cert: Buffer | string; readonly key: Buffer | string };
  /** Explicit rather than the global one, so nothing here can reach a network a caller did not hand it. */
  fetching: Fetching;
  /** The built web client, when this deployment has one to serve. */
  web?: ReadonlyMap<string, WebAsset>;
  /** The session store, where a deployment keeps sessions. Without one, nothing changes through here. */
  sessions?: SessionStore;
  /** Where accounts are kept and what is done to them is recorded. Without it, there is nothing to claim. */
  identity?: Identity;
  /** Whether a restore was recently applied (OPS-06). Without it, a session a restore ended is refused
   * with an ordinary sign-in-again rather than told to update, the same as before this store existed. */
  compatibility?: RestoreCompatibility;
  /** The same database as the audit trail, with the notification store’s mutation methods. */
  notificationDb?: NotificationDb;
  /** Where a Guest's invitation or an output window's capability is kept. Without it, there is none to grant. */
  capabilities?: CapabilityStore;
  /** Where the settings file is written and hot-reloaded. Without it, there is nothing to administer. */
  settingsAdmin?: SettingsAdmin;
  /** Where Slide Layouts are kept. Without it, there is none to create, version or archive. */
  slideLayouts?: SlideLayoutStore;
  /** Where an earlier revision of Slide Layouts and Service Templates is read, compared and restored. */
  revisions?: RevisionStore;
  /** Where a losing edit is kept rather than discarded (spec COLL-01). Without it, there is none to settle. */
  conflictShelf?: ConflictShelf;
  /** Where an uploaded file becomes a media asset. Without it, there is nowhere for one to be uploaded to. */
  media?: MediaLibrary;
  /** Reads the retained bytes behind a media record without buffering the whole file. */
  mediaBytes?: MediaByteSource;
  /** The same content database `backups.db` above also points at, handed separately here because a
   * deployment could in principle have media to purge without also having backups configured. Lets
   * the media cleanup routes scan slide groups and reusable slides for live references (OPS-14)
   * instead of grading every asset unreferenced. Without it, that scan is skipped and everything
   * grades unreferenced, same as before this scan existed. */
  contentDb?: RepositoryDb;
  /** Where a backup is recorded and where an on-demand run is queued. Without both, there is
   * nothing here to trigger or list. */
  backups?: { readonly db: RepositoryDb; readonly queue: Queue };
  /** The same driver `Db` `backups.db`/`contentDb` are `RepositoryDb` views of, narrowed differently for
   * OPS-09's own database health reading. Without it, the operational health route answers not-found,
   * the same as it does without `backups`/`media`. */
  mongoDb?: MongoHealthDb;
  /** The restore-apply lease `guardMaintenance` reads. Without it, no request is ever refused for one. */
  readonly maintenance?: MaintenanceStore;
  /** Where the last media storage-root migration is recorded (OPS-16). Without it, there is
   * nothing here to trigger a migration against or clean up after one. */
  readonly migrationState?: MediaMigrationStateStore;
  /** Where a translation's offset is kept. Without it, there is none to read or configure. */
  translationOffsets?: TranslationOffsetStore;
  /** Where an account's last workspace position is kept. Without it, there is none to read or save. */
  workspacePositions?: WorkspacePositionStore;
  /** Checks whether a library content record remains available to its owner. */
  contentExists?: (context: unknown, id: string) => Promise<boolean>;
  /** Where what an operator showed is recorded. Without it, this deployment shows no reference at all. */
  shownReferences?: ShownReferenceStore;
  /** Where who is editing what is kept. Without it, there is nobody here to observe. */
  presence?: PresenceStore;
  services?: ServiceStore;
  serviceTemplates?: ServiceTemplateStore;
  preparation?: PreparationStore;
  /** Where a run's own row is kept. Without it, `run-routes.ts` serves every path not-found, the same as
   *  every other optional store here, and the override route's own D-8 ownership check is skipped. */
  runs?: RunStore;
  slideLabels?: SlideLabelStore;
  themes?: ThemeStore;
  runReview?: RunReviewStore;
  midService?: MidServiceStore;
  /** The run engine `run-routes.ts` starts and ends runs through — Task 8's own store, wrapping `runs`
   *  with the in-memory state a live command needs. Without it, the run surface serves not-found. */
  runEngine?: RunEngine;
  /** Derives a run's deck without exposing raw stores to `run-routes.ts`, the same seam the run engine
   *  itself takes a `deck` function through. */
  deck?: (context: unknown, run: RunRecord) => Promise<RunDeck>;
  /** Where a Song is kept. Without it, there is none to create, edit, export or generate slides from. */
  songs?: SongStore;
  chords?: SongSingerChordsStore;
  /** Where a Sermon is kept. Without it, there is none to create, edit or generate slides from. */
  sermons?: SermonStore;
  /** Where a Slide Group is kept. Without it, there is none to create, edit or regenerate. */
  slideGroups?: SlideGroupStore;
  /** Where every Song and Sermon is indexed together. Without it, there is nothing here to list. */
  library?: LibraryStore;
  /** Where the content-language registry is kept. Without it, there is none to create, edit or archive. */
  contentLanguages?: ContentLanguageStore;
  /** Where an uploaded `.pptx` is extracted. Without it, and the three below, there is no import to run. */
  pptxImport?: PptxImport;
  /** Where an import's blocks are graded against the slide-label catalogue. */
  pptxReview?: PptxReview;
  /** Where a reviewed import becomes a Song, or is appended to one. */
  pptxCommit?: PptxCommit;
  /** Where an import is held between upload, review and commit. */
  pptxSessions?: PptxSessionStore;
  /** Bare ANTHROPIC_API_KEY, optional, never logged — absent disables the sermon import resolver. */
  anthropicApiKey?: string | undefined;
}

/**
 * The versioned surface. Only an API client has a contract version to send; a liveness probe has none,
 * and neither does the browser asking for the document that becomes the client. Gating those on a
 * header they cannot send would answer a first visit with "update your client".
 */
export const VERSIONED_PREFIX = '/api/';

export function buildApp({
  settings,
  logger,
  https,
  fetching,
  web,
  sessions,
  identity,
  compatibility,
  notificationDb,
  capabilities,
  settingsAdmin,
  slideLayouts,
  revisions,
  conflictShelf,
  media,
  mediaBytes,
  contentDb,
  backups,
  mongoDb,
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
  slideLabels,
  themes,
  runReview,
  midService,
  runEngine,
  deck,
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
}: AppOptions): FastifyInstance {
  const notifications = identity === undefined || notificationDb === undefined
    ? undefined
    : notificationStoreOn(notificationDb, { now: () => new Date().toISOString() });
  // HTTPS makes Fastify infer a specialised server, while the routes below use its common interface.
  const app = Fastify({ logger, ...(https === undefined ? {} : { https }) }) as unknown as FastifyInstance;
  const corpus = corpusClient({ url: settings.values.corpusUrl, token: settings.values.corpusToken }, fetching);

  withSecurityHeaders(app);
  // A real, enforced ceiling on the request body itself (THR-07): an oversized upload is refused while
  // its body is still streaming in, never buffered whole before `media-routes.ts` ever sees it. Fastify
  // defers every registration below to boot, so this needs no `await` to take effect before a route does.
  app.register(multipart, { limits: { fileSize: settings.values.mediaUploadLimitBytes } });
  // A `.pptx` upload arrives as its own raw bytes, not as a multipart form: this one content type only,
  // so no other route's body is read any differently. Its size ceiling is the import route's own.
  app.addContentTypeParser(
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    { parseAs: 'buffer' },
    (_request, payload, done) => done(null, payload),
  );
  // Before every route, so a fault in one of them answers with a code and not with what it threw. The
  // one exception is a deployment that set `developmentDiagnostics` in its own environment, which the
  // settings file cannot do and an administrator's request therefore cannot either.
  withSafeErrors(app, { diagnostics: settings.values.developmentDiagnostics });

  // Decided before routing, so a client this build cannot serve is told to update rather than being
  // handed a not-found for a route it was asking for in an older shape.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith(VERSIONED_PREFIX)) return;
    // A request asking to stop being an HTTP request is graded by the socket route instead, which can
    // close with a reason a browser client can read — a refused handshake carries none.
    if (isUpgrade(request.headers)) return;
    const decision = decideClient(request.headers[CLIENT_VERSION_HEADER]);
    if (decision.accepted) return;
    await reply.code(decision.status).send(
      errorEnvelope(decision.code, decision.message, request.id, [
        { path: CLIENT_VERSION_HEADER, code: decision.code, message: `supported versions: ${decision.supported.join(', ')}` },
      ]),
    );
  });

  // Installed before the first route is registered, which is what makes `mutatingRoutesOf` the whole
  // list of the routes that change something: a route registered above this line would be missing from it.
  guardMutations(app, { sessions, compatibility });

  // Installed beside the guard above, the same reach: a restore mid-apply refuses every mutation until
  // its lease is released, whichever route below would otherwise have handled it.
  guardMaintenance(app, { maintenance, now: () => new Date().toISOString() });

  // Installed right after: a mutating route's session is already proved by the guard above by the time
  // this asks for it, and every route registered from here down is one this check was on for.
  enforceAuthorization(app, { sessions, identity, compatibility });

  // A path the client routes to itself is answered with the shell, so a reload or a shared link lands on
  // the page it names; everything else that nothing serves stays the JSON 404 the API has always given.
  const shell = web === undefined ? undefined : shellFallback(web);
  app.setNotFoundHandler((request, reply) => shell?.(request, reply) ?? reply.code(404).send(notFound(request)));

  app.get('/health', { config: { need: PUBLIC } }, (request) =>
    successEnvelope({ status: 'ok', locale: settings.values.locale }, request.id, CLIENT_WINDOW.current),
  );

  // What a client is allowed to depend on, served from the same registry the boot check grades.
  app.get('/api/contracts', { config: { need: PUBLIC } }, (request) =>
    successEnvelope(
      { clientVersions: supportedClientVersions(), messageCodes: MESSAGE_CODES },
      request.id,
      CLIENT_WINDOW.current,
    ),
  );

  // The library is read here and nowhere else: a client asks this application, this application asks
  // the corpus with a credential a client never sees, and a refusal is translated on the way back.
  app.get('/api/v1/translations', { config: { need: PUBLIC } }, async (request, reply) => {
    const answer = await corpus.translations();
    if (!answer.ok) {
      return reply
        .code(answer.refusal.status)
        .send(errorEnvelope(answer.refusal.code, answer.refusal.message, request.id));
    }
    return successEnvelope({ translations: answer.value }, request.id, CLIENT_WINDOW.current);
  });

  // The canon of one translation: which books it holds and which chapters of each, so an editor's
  // choices can be checked before anything is read. Mirrors the route above in every way but the path.
  app.get('/api/v1/translations/:abbr/canon', { config: { need: PUBLIC } }, async (request, reply) => {
    const { abbr } = request.params as { readonly abbr: string };
    const answer = await corpus.canon(abbr);
    if (!answer.ok) {
      return reply
        .code(answer.refusal.status)
        .send(errorEnvelope(answer.refusal.code, answer.refusal.message, request.id));
    }
    return successEnvelope({ canon: answer.value }, request.id, CLIENT_WINDOW.current);
  });

  // One validated reference: the book and chapter are checked against the canon before the library is
  // asked at all, and the verses it answers with carry the revision they were read at.
  app.get('/api/v1/translations/:abbr/verses', { config: { need: PUBLIC } }, async (request, reply) => {
    const { abbr } = request.params as { readonly abbr: string };
    // Read as unknowns rather than as strings: a field sent twice arrives as a list, and the grammar
    // below is what refuses that, which it can only do if the type does not claim it cannot happen.
    const reference = referenceFrom(abbr, request.query as Record<string, unknown>);
    if (reference === undefined) {
      return reply
        .code(REFERENCE_MALFORMED.status)
        .send(errorEnvelope(REFERENCE_MALFORMED.code, REFERENCE_MALFORMED.message, request.id));
    }
    const answer = await selectReference(corpus, reference);
    if (!answer.ok) {
      return reply
        .code(answer.refusal.status)
        .send(errorEnvelope(answer.refusal.code, answer.refusal.message, request.id));
    }
    return successEnvelope({ verses: answer.value }, request.id, CLIENT_WINDOW.current);
  });

  // Both are registered below the guard like everything else, and the two changes they serve without a
  // session are reached only because the guard declares them: claiming, which closes the moment the
  // instance is claimed, and signing in, which is how a session comes to exist at all.
  serveOnboarding(app, { identity });

  serveSessionRoutes(app, { sessions, identity });

  // Behind the guard, unlike the two above: a second factor is enrolled and given up by an operator who
  // is already signed in, which is what lets this surface say plainly what a sign-in never may.
  serveTotpRoutes(app, { identity });
  servePasskeyRoutes(app, { identity });

  // Presence, history and the conflict shelf are all keyed by a content id alone; this says which surface
  // an id belongs to, so each of them asks that surface's own permission before answering for it.
  const kindOf = contentKindResolver({ slideLayouts, serviceTemplates });

  // Presence is gated by a permission like everything below, but one every role is granted — Member
  // included — so nothing here narrows who may say they are editing something.
  servePresenceRoutes(app, { presence, identity, kindOf });

  // The first route this server asks a permission of, and not merely a proved session: administering
  // another account is Admin's alone, by the roles this server enforces.
  serveAccountRoutes(app, { identity, sessions });

  // Behind the same permission as the account surface above: issuing a Guest's invitation or an output
  // window's capability is Control presentation's, not merely a proved session's.
  serveCapabilityRoutes(app, { capabilities, identity });

  // Behind the same permission as the account surface: reading or changing the settings file is Admin's
  // alone, the same as administering an account is.
  serveSettingsRoutes(app, { settingsAdmin, identity });

  // Its own permission, Admin's alone: viewing and toggling a third-party integration is administering
  // this deployment, the same reach as the settings file above but not the same permission.
  serveIntegrationRoutes(app, { settingsAdmin, identity, anthropicApiKey });

  // Behind the same permission again, by a vocabulary of its own: a Slide Layout is Admin's to create,
  // to save forward and to stop offering, and nobody else's to change.
  serveSlideLayoutRoutes(app, { slideLayouts, identity, slideGroups, library });

  // Behind a permission of its own, granted to Admin and Editor: reading, comparing and restoring an
  // earlier revision of whatever content already versions itself through `revisions.ts`.
  serveRevisionRoutes(app, { revisions, identity, kindOf });

  // Behind the same permission the content stores it shelves for already grant: what is still waiting
  // to be settled for one piece of content, and the one way an editor settles it (spec COLL-01).
  serveConflictRoutes(app, { conflictShelf, revisions, identity, kindOf });

  // Behind a permission of its own, Admin's alone: reading the administrative trail `audit.ts` writes.
  serveAuditRoutes(app, { identity });

  // Behind the same permission again, by a vocabulary of its own: uploading to the media library is
  // Admin's, and THR-07's defenses stand between this route and `MediaLibrary.upload()` — never inside it.
  serveMediaRoutes(app, { media, identity, slideGroups, library, settingsAdmin });
  serveMediaDeliveryRoutes(app, { media, bytes: mediaBytes });

  // Behind the same permission once more: reporting what is safe to remove from the media library,
  // and performing a reviewed purge of it. Reuses the media surface's own `media` — the same source
  // `serveMediaRoutes` above already reads and writes.
  serveMediaCleanupRoutes(app, {
    media,
    db: contentDb,
    now: () => new Date().toISOString(),
    settingsAdmin,
    identity,
  });

  // Behind its own Admin permission: listing recorded backups and asking for an on-demand run.
  serveBackupRoutes(app, {
    db: backups?.db,
    queue: backups?.queue,
    now: () => new Date().toISOString(),
    identity,
  });

  // Behind the same permission as the backup surface, by its own vocabulary: applying a recorded backup
  // to production. Reuses the backup surface's own `db`/`queue` — a restore-apply job is the same kind
  // of queued work a backup run is, kept in the same repositories.
  serveRestoreRoutes(app, {
    db: backups?.db,
    queue: backups?.queue,
    now: () => new Date().toISOString(),
    identity,
  });

  // Behind its own Admin permission: showing what the queue holds and trying a failed job again.
  // Reuses the backup surface's own `queue` — the same queue every backup, restore-apply and future
  // job kind is recorded in.
  serveJobRoutes(app, {
    queue: backups?.queue,
    identity,
  });

  // Behind its own Admin permission, by its own vocabulary: asking this deployment to migrate its media
  // storage to a new root, and cleaning up the old one afterward (OPS-16). Reuses the backup surface's
  // own `queue` for the same reason `serveJobRoutes` does above.
  serveMediaMigrationRoutes(app, {
    queue: backups?.queue,
    migrationState,
    now: () => new Date().toISOString(),
    identity,
    settingsAdmin,
  });

  // Behind its own Admin permission: the operational health report OPS-09 defines. Reuses the backup
  // surface's own `db`/`queue` and the media surface's own `media`, the same sources every reader above
  // already reads from — this route only ever reports on them, never changes them.
  serveOperationsRoutes(app, {
    db: backups?.db,
    queue: backups?.queue,
    media,
    dataDir: settings.values.dataDir,
    now: () => new Date().toISOString(),
    identity,
    mongoDb,
    corpus,
    corpusConfigured: settings.values.corpusUrl !== '',
    settingsAdmin,
  });

  serveNotificationRoutes(app, {
    store: notifications,
    events: identity === undefined || notificationDb === undefined ? undefined : repositoriesOn(notificationDb).auditEvents,
    identity,
  });

  // Reading is public, the same as the corpus routes above: BIBL-02 calls an offset inspectable, and
  // there is nothing in one worth a session. Setting one is behind the same permission once again.
  serveTranslationOffsetRoutes(app, { translationOffsets, identity });

  // The operator's own half of the library: looking a reference up mid-service, and showing one, which is
  // the only read of a passage this server writes down. Behind Control presentation, the same permission
  // the capability surface above is behind, because running a presentation is what this surface is for.
  serveReferenceRoutes(app, { corpus, shownReferences, runReview, runs, deck });
  serveOrderRoutes(app, { services, slideLabels });
  serveOutputDefaultsRoutes(app, { uploadLimitBytes: settings.values.mediaUploadLimitBytes });
  serveServiceRoutes(app, { services });
  serveWorkspacePositionRoutes(app, { workspacePositions, services, contentExists });
  serveServiceTemplateRoutes(app, { serviceTemplates, identity, services });
  servePreparationRoutes(app, { preparation, runs });

  // The presentation run surface itself: starting and ending a run, its state and its deck, its theme,
  // mid-service additions, and reviewing or exporting what it showed. Behind Control presentation, bar
  // the deck route, which a capability ticket may read instead of a session (D-4).
  serveRunRoutes(app, { runs, runEngine, runReview, themes, midService, capabilities, sessions, identity, deck });

  // The content surfaces content-routes spec adds: songs, sermons, slide groups and the library are each
  // behind `content.edit` alone, the one permission an Editor holds and an Admin's own catalogue
  // permissions above are deliberately not — this is what an Editor builds a service's content with, not
  // what an Admin administers the catalogue with. Scripture search sits beside them but is reachable by
  // either `content.edit` or `presentation.control`, since Control presentation searches mid-service too.
  serveSongRoutes(app, { songs, chords, identity });
  // The integrations page's switch, read per preview so a change there applies without a restart.
  const sermonAi = settingsAdmin === undefined
    ? undefined
    : () => sermonAiSwitch(settingsAdmin.current().values, anthropicApiKey);
  serveSermonRoutes(app, { sermons, corpus, identity, anthropicApiKey, sermonAi });
  serveSlideGroupRoutes(app, { slideGroups, identity });
  serveLibraryRoutes(app, { library, identity, services, serviceTemplates });
  serveScriptureSearchRoutes(app, { corpus });

  // Their own permission again, the same Admin's tier as the Slide Layout and media surfaces above but not
  // the same permission: administering the content-language registry and the slide-label catalogue is
  // gated behind `catalogue.manage`, read there behind `content.edit` the same as an Editor's other surfaces.
  serveContentLanguageRoutes(app, { contentLanguages, identity, songs, slideGroups, library, sermons });
  serveSlideLabelRoutes(app, { slideLabels, identity, songs, slideGroups, library, sermons });

  // Behind `services.manage`, the same as the sermon import preview: bringing a PowerPoint deck in is a
  // service integration rather than content editing, even though what it ends in is a Song.
  servePptxRoutes(app, { pptxImport, pptxReview, pptxCommit, pptxSessions, identity });

  if (web !== undefined) serveWebClient(app, web);

  return app;
}
