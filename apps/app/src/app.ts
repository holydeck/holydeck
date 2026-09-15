import { CLIENT_VERSION_HEADER, CLIENT_WINDOW, decideClient, supportedClientVersions } from '@holydeck/contracts/clients';
import { MESSAGE_CODES, errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import { serveAccountRoutes } from './accounts-routes.js';
import { enforceAuthorization } from './authorization.js';
import { corpusClient } from './corpus.js';
import { guardMutations } from './csrf.js';
import { notFound, withSafeErrors } from './failures.js';
import { isUpgrade } from './live.js';
import { serveOnboarding } from './onboarding.js';
import { servePasskeyRoutes } from './passkey-routes.js';
import { serveSessionRoutes } from './session-routes.js';
import { serveTotpRoutes } from './totp-routes.js';
import { serveWebClient, withSecurityHeaders } from './static.js';

import type { RouteNeed } from './authorization.js';
import type { Fetching } from './corpus.js';
import type { Identity } from './onboarding.js';
import type { SessionStore } from './sessions.js';
import type { LoadedSettings } from './settings.js';
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
}

/**
 * The versioned surface. Only an API client has a contract version to send; a liveness probe has none,
 * and neither does the browser asking for the document that becomes the client. Gating those on a
 * header they cannot send would answer a first visit with "update your client".
 */
export const VERSIONED_PREFIX = '/api/';

export function buildApp({ settings, logger, fetching, web, sessions, identity }: AppOptions): FastifyInstance {
  const app = Fastify({ logger });
  const corpus = corpusClient({ url: settings.values.corpusUrl, token: settings.values.corpusToken }, fetching);

  withSecurityHeaders(app);
  // Before every route, so a fault in one of them answers with a code and not with what it threw.
  withSafeErrors(app);

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
  enforceAuthorization(app, { sessions });

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

  if (web !== undefined) serveWebClient(app, web);

  return app;
}
