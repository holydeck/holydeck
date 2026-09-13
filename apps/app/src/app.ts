import { CLIENT_VERSION_HEADER, CLIENT_WINDOW, decideClient, supportedClientVersions } from '@holydeck/contracts/clients';
import { MESSAGE_CODES, errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import type { LoadedSettings } from './settings.js';

export interface AppOptions {
  settings: LoadedSettings;
  /** Explicit rather than defaulted: a service that silently stops logging is hard to notice. */
  logger: FastifyServerOptions['logger'];
}

/**
 * Paths served without a client version. A liveness probe is not a client of the contract and has no
 * version to send; everything a client actually talks to is behind the compatibility window.
 */
export const PUBLIC_PATHS = ['/health'] as const;

const NOT_FOUND = 'resource.not_found';

const isPublic = (url: string): boolean => PUBLIC_PATHS.some((path) => path === url.split('?')[0]);

export function buildApp({ settings, logger }: AppOptions): FastifyInstance {
  const app = Fastify({ logger });

  // Decided before routing, so a client this build cannot serve is told to update rather than being
  // handed a not-found for a route it was asking for in an older shape.
  app.addHook('onRequest', async (request, reply) => {
    if (isPublic(request.url)) return;
    const decision = decideClient(request.headers[CLIENT_VERSION_HEADER]);
    if (decision.accepted) return;
    await reply.code(decision.status).send(
      errorEnvelope(decision.code, decision.message, request.id, [
        { path: CLIENT_VERSION_HEADER, code: decision.code, message: `supported versions: ${decision.supported.join(', ')}` },
      ]),
    );
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send(errorEnvelope(NOT_FOUND, `${request.method} ${request.url} is not a path this server serves.`, request.id)),
  );

  app.get('/health', (request) =>
    successEnvelope({ status: 'ok', locale: settings.values.locale }, request.id, CLIENT_WINDOW.current),
  );

  // What a client is allowed to depend on, served from the same registry the boot check grades.
  app.get('/api/contracts', (request) =>
    successEnvelope(
      { clientVersions: supportedClientVersions(), messageCodes: MESSAGE_CODES },
      request.id,
      CLIENT_WINDOW.current,
    ),
  );

  return app;
}
