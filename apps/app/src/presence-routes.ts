// Where an editor says they are here, who else is, and that they have gone (spec v1c-09, COLAB-01).
//
// No audit trail: presence is operational state, not a change worth a permanent record, and
// `apps/app/src/presence.ts`'s own header says so plainly. No conflict handling either — the store
// never refuses a call for anything but a bad context, which is a fault, not something a caller
// corrects.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { parsePresenceEnter } from '@holydeck/contracts/presence';

import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { editorPresence } from './presence.js';
import { PRESENCE_USE } from './roles.js';

import type { RouteNeed } from './authorization.js';
import type { PresenceStore } from './presence.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const PRESENCE_PREFIX = 'presence:';

/** Who is editing this content, right now. */
export const PRESENCE_PATH = '/api/v1/presence/:contentId';

const PERMISSION: RouteNeed = { kind: 'permission', need: PRESENCE_USE };

const ROUTES = [
  ['POST', PRESENCE_PATH],
  ['GET', PRESENCE_PATH],
  ['DELETE', PRESENCE_PATH],
] as const;

export interface PresenceRoutesOptions {
  /** Absent in a deployment with nowhere to keep an entry, which has none here to observe. */
  readonly presence: PresenceStore | undefined;
}

export function servePresenceRoutes(app: FastifyInstance, { presence }: PresenceRoutesOptions): void {
  if (presence === undefined) {
    for (const [method, url] of ROUTES) {
      app.route({
        method,
        url,
        config: { need: PERMISSION },
        handler: (request: FastifyRequest, reply: FastifyReply) => reply.code(404).send(notFound(request)),
      });
    }
    return;
  }

  const store = presence;

  const call = (request: FastifyRequest) =>
    editorPresence(provenSession(request).record.actor, correlationFor(PRESENCE_PREFIX, request.id));

  const contentIdOf = (request: FastifyRequest, reply: FastifyReply): string | undefined => {
    const parsed = parsePresenceEnter(request.params, 'params');
    if (!parsed.ok) {
      reply.code(422).send(validationFailure(request.id, parsed.problems));
      return undefined;
    }
    return parsed.value.contentId;
  };

  app.post(PRESENCE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const contentId = contentIdOf(request, reply);
    if (contentId === undefined) return reply;
    const entry = await store.enter(call(request), { contentId });
    return reply.send(successEnvelope(entry, request.id, CLIENT_WINDOW.current));
  });

  app.get(PRESENCE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const contentId = contentIdOf(request, reply);
    if (contentId === undefined) return reply;
    const entries = await store.list(call(request), contentId);
    return reply.send(successEnvelope(entries, request.id, CLIENT_WINDOW.current));
  });

  app.delete(PRESENCE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const contentId = contentIdOf(request, reply);
    if (contentId === undefined) return reply;
    await store.leave(call(request), { contentId });
    return reply.code(204).send();
  });
}
