import { CLIENT_VERSION_HEADER, CLIENT_WINDOW, decideClient, supportedClientVersions } from '@holydeck/contracts/clients';
import { MESSAGE_CODES, errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import { serveAccountRoutes } from './accounts-routes.js';
import { enforceAuthorization } from './authorization.js';
import { serveCapabilityRoutes } from './capability-routes.js';
import { REFERENCE_MALFORMED, corpusClient, referenceFrom, selectReference } from './corpus.js';
import { guardMutations } from './csrf.js';
import { notFound, withSafeErrors } from './failures.js';
import { isUpgrade } from './live.js';
import { serveOnboarding } from './onboarding.js';
import { servePasskeyRoutes } from './passkey-routes.js';
import { serveReferenceRoutes } from './reference-routes.js';
import { serveSessionRoutes } from './session-routes.js';
import { serveSettingsRoutes } from './settings-routes.js';
import { serveSlideLayoutRoutes } from './slide-layout-routes.js';
import { serveTotpRoutes } from './totp-routes.js';
import { serveTranslationOffsetRoutes } from './translation-offset-routes.js';
import { serveWebClient, withSecurityHeaders } from './static.js';

import type { RouteNeed } from './authorization.js';
import type { CapabilityStore } from './capabilities.js';
import type { Fetching } from './corpus.js';
import type { Identity } from './onboarding.js';
import type { SettingsAdmin } from './settings-admin.js';
import type { SlideLayoutStore } from './slide-layouts.js';
import type { SessionStore } from './sessions.js';
import type { LoadedSettings } from './settings.js';
import type { ShownReferenceStore } from './shown-references.js';
import type { TranslationOffsetStore } from './translation-offsets.js';
import type { WebAsset } from './static.js';

const PUBLIC: RouteNeed = { kind: 'public' };

export interface AppOptions {
  settings: LoadedSettings;
  /** Explicit rather than defaulted: a service that silently stops logging is hard to notice. */
  logger: FastifyServerOptions['logger'];
  /** Explicit rather than the global one, so nothing here can reach a network a caller did not hand it. */
  fetching: Fetching;
  /** The built web client, when this deployment has one to serve. */
  web?: ReadonlyMap<string, WebAsset>;
  /** The session store, where a deployment keeps sessions. Without one, nothing changes through here. */
  sessions?: SessionStore;
  /** Where accounts are kept and what is done to them is recorded. Without it, there is nothing to claim. */
  identity?: Identity;
  /** Where a Guest's invitation or an output window's capability is kept. Without it, there is none to grant. */
  capabilities?: CapabilityStore;
  /** Where the settings file is written and hot-reloaded. Without it, there is nothing to administer. */
  settingsAdmin?: SettingsAdmin;
  /** Where Slide Layouts are kept. Without it, there is none to create, version or archive. */
  slideLayouts?: SlideLayoutStore;
  /** Where a translation's offset is kept. Without it, there is none to read or configure. */
  translationOffsets?: TranslationOffsetStore;
  /** Where what an operator showed is recorded. Without it, this deployment shows no reference at all. */
  shownReferences?: ShownReferenceStore;
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
  fetching,
  web,
  sessions,
  identity,
  capabilities,
  settingsAdmin,
  slideLayouts,
  translationOffsets,
  shownReferences,
}: AppOptions): FastifyInstance {
  const app = Fastify({ logger });
  const corpus = corpusClient({ url: settings.values.corpusUrl, token: settings.values.corpusToken }, fetching);

  withSecurityHeaders(app);
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
  guardMutations(app, { sessions });

  // Installed right after: a mutating route's session is already proved by the guard above by the time
  // this asks for it, and every route registered from here down is one this check was on for.
  enforceAuthorization(app, { sessions, identity });

  app.setNotFoundHandler((request, reply) => reply.code(404).send(notFound(request)));

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

  // The first route this server asks a permission of, and not merely a proved session: administering
  // another account is Admin's alone, by the roles this server enforces.
  serveAccountRoutes(app, { identity });

  // Behind the same permission as the account surface above: issuing a Guest's invitation or an output
  // window's capability is Control presentation's, not merely a proved session's.
  serveCapabilityRoutes(app, { capabilities, identity });

  // Behind the same permission as the account surface: reading or changing the settings file is Admin's
  // alone, the same as administering an account is.
  serveSettingsRoutes(app, { settingsAdmin, identity });

  // Behind the same permission again, by a vocabulary of its own: a Slide Layout is Admin's to create,
  // to save forward and to stop offering, and nobody else's to change.
  serveSlideLayoutRoutes(app, { slideLayouts, identity });

  // Reading is public, the same as the corpus routes above: BIBL-02 calls an offset inspectable, and
  // there is nothing in one worth a session. Setting one is behind the same permission once again.
  serveTranslationOffsetRoutes(app, { translationOffsets, identity });

  // The operator's own half of the library: looking a reference up mid-service, and showing one, which is
  // the only read of a passage this server writes down. Behind Control presentation, the same permission
  // the capability surface above is behind, because running a presentation is what this surface is for.
  serveReferenceRoutes(app, { corpus, shownReferences });

  if (web !== undefined) serveWebClient(app, web);

  return app;
}
