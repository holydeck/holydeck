import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { LIBRARY_PATH, parseLibraryFilter } from '@holydeck/contracts/library';

import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { libraryContext } from './library.js';
import { CONTENT_EDIT } from './roles.js';

import type { RouteNeed } from './authorization.js';
import type { LibraryStore } from './library.js';
import type { Identity } from './onboarding.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const LIBRARY_PREFIX = 'library:';
export const LIBRARY_ID_PATH = `${LIBRARY_PATH}/:id`;
const ROUTES = [['GET', LIBRARY_PATH], ['GET', LIBRARY_ID_PATH]] as const;
const PERMISSION: RouteNeed = { kind: 'permission', need: CONTENT_EDIT };
const idIn = (request: FastifyRequest): string => (request.params as { readonly id: string }).id;

export interface LibraryRoutesOptions {
  readonly library: LibraryStore | undefined;
  readonly identity: Identity | undefined;
}

export function serveLibraryRoutes(app: FastifyInstance, { library, identity }: LibraryRoutesOptions): void {
  if (identity === undefined) {
    for (const [method, url] of ROUTES) {
      app.route({ method, url, config: { need: PERMISSION }, handler: (request, reply) => reply.code(404).send(notFound(request)) });
    }
    return;
  }
  const store = library as LibraryStore;
  const call = (request: FastifyRequest) =>
    libraryContext(provenSession(request).record.actor, correlationFor(LIBRARY_PREFIX, request.id));

  app.get(LIBRARY_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseLibraryFilter(request.query, 'library');
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const items = await store.list(call(request), parsed.value);
    return reply.send(successEnvelope(items, request.id, CLIENT_WINDOW.current));
  });

  app.get(LIBRARY_ID_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const item = await store.get(call(request), idIn(request));
    if (item === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(item, request.id, CLIENT_WINDOW.current));
  });
}
