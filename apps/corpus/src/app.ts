import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { HolyDeckError } from '@holydeck/core/messages';
import { requireApiToken, requireProxyToken } from './auth.js';
import { API_ENDPOINTS, errorEnvelope, statusForCode } from './errors.js';
import { registerHealthRoute } from './routes/health.js';
import { registerLegacyVerseRoute } from './routes/legacy.js';
import { registerRenderRoute } from './routes/render.js';
import { registerSearchRoute } from './routes/search.js';
import { registerStatsRoute } from './routes/stats.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerTranslationsRoutes } from './routes/translations.js';
import { registerVersesRoute } from './routes/verses.js';
import type { FastifyError, FastifyInstance, FastifyServerOptions } from 'fastify';
import type { Fetcher } from '@holydeck/core/fetcher';
import type { MongoStore } from './mongo-store.js';
import type { SyncJobManager } from './jobs.js';

export interface AppDeps {
  store: MongoStore;
  fetcher: Fetcher;
  jobs: SyncJobManager;
  version: string;
  logger?: FastifyServerOptions['logger'];
  /** Set by a deployment that keeps this service internal; absent leaves /api/v1 open. */
  apiToken?: string;
  /** Additional tokens scoped to the read/render routes below; never accepted on sync, stats or search. */
  clientTokens?: readonly string[];
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });

  void app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) =>
      Object.assign(new HolyDeckError('rate_limit_exceeded'), { statusCode: context.statusCode }),
  });

  app.addContentTypeParser(
    ['application/yaml', 'application/x-yaml', 'text/yaml', 'text/plain'],
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HolyDeckError) {
      void reply.code(statusForCode(error.code)).send(errorEnvelope(error));
      return;
    }
    if (error.validation !== undefined || (typeof error.statusCode === 'number' && error.statusCode < 500)) {
      void reply
        .code(400)
        .send(errorEnvelope(new HolyDeckError('request_invalid', { reason: error.message })));
      return;
    }
    request.log.error(error);
    void reply.code(500).send(errorEnvelope(new HolyDeckError('internal_error')));
  });

  app.setNotFoundHandler((request, reply) => {
    const error = new HolyDeckError('route_not_found', { method: request.method, path: request.url });
    void reply.code(404).send({ ...errorEnvelope(error), endpoints: API_ENDPOINTS });
  });

  registerHealthRoute(app, deps);

  const apiToken = deps.apiToken;
  const clientTokens = deps.clientTokens ?? [];

  void app.register(
    async (api) => {
      // Only the API is closed. /health is registered outside this scope and stays open, because a
      // deployment that cannot tell whether the service is alive is worse off than one that can.
      if (apiToken !== undefined) {
        api.addHook('onRequest', async (request) => {
          requireApiToken(request.headers, apiToken);
        });
      }
      registerSearchRoute(api, deps);
      registerSyncRoutes(api, deps);
      registerStatsRoute(api, deps);
      registerLegacyVerseRoute(api, deps);
    },
    { prefix: '/api/v1' },
  );

  // Read and render: the routes the app's corpus proxy (REL-09) exposes to CLI users, so a client token
  // is enough here even though it is never accepted on the admin-scoped routes registered above.
  void app.register(
    async (api) => {
      if (apiToken !== undefined) {
        api.addHook('onRequest', async (request) => {
          requireProxyToken(request.headers, apiToken, clientTokens);
        });
      }
      registerTranslationsRoutes(api, deps);
      registerVersesRoute(api, deps);
      registerRenderRoute(api, deps);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
