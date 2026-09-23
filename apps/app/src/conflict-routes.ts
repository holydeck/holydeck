// The conflict shelf's own surface: what is still waiting to be settled for one piece of content, and the
// one way an editor settles it (spec v1c-09, COLL-01). Strategy resolution lives here rather than in
// `conflicts.ts`: `keep-mine` and `keep-theirs` both read a body this route already has to fetch anyway —
// the shelved entry, or the standing revision — and `combine` carries the body the client already
// resolved by hand, so `resolveConflict()` only ever receives the one body it is to save, never has to
// choose between three.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { isShelved, parseConflictResolution, shelfKey } from '@holydeck/contracts/collaboration';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';

import { correlationFor, requestContext } from './context.js';
import { ConflictError, SHELF_PERMISSIONS } from './conflicts.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { REVISION_PERMISSIONS, RevisionError } from './revisions.js';
import { CONTENT_EDIT, LAYOUTS_MANAGE, SERVICE_TEMPLATES_MANAGE } from './roles.js';

import type { RouteNeed } from './authorization.js';
import type { ConflictShelf } from './conflicts.js';
import type { RevisionStore } from './revisions.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const CONFLICT_PREFIX = 'conflict:';

export const CONFLICTS_PATH = '/api/v1/content/:contentId/conflicts';
export const CONFLICT_RESOLVE_PATH = '/api/v1/content/:contentId/conflicts/:shelfEntryId/resolve';

const PERMISSION: RouteNeed = {
  kind: 'any-permission',
  needs: [CONTENT_EDIT, LAYOUTS_MANAGE, SERVICE_TEMPLATES_MANAGE],
};

const ROUTES = [
  ['GET', CONFLICTS_PATH],
  ['POST', CONFLICT_RESOLVE_PATH],
] as const;

export interface ConflictRoutesOptions {
  readonly conflictShelf: ConflictShelf | undefined;
  readonly revisions: RevisionStore | undefined;
}

export function serveConflictRoutes(app: FastifyInstance, { conflictShelf, revisions }: ConflictRoutesOptions): void {
  if (conflictShelf === undefined || revisions === undefined) {
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

  const shelf = conflictShelf;
  const store = revisions;

  const call = (request: FastifyRequest) =>
    requestContext({
      actor: provenSession(request).record.actor,
      correlationId: correlationFor(CONFLICT_PREFIX, request.id),
      permissions: [...Object.values(SHELF_PERMISSIONS), ...Object.values(REVISION_PERMISSIONS)],
    });

  app.get(CONFLICTS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const { contentId } = request.params as { contentId: string };
    const context = call(request);
    const [outstanding, entries] = await Promise.all([
      shelf.outstanding(context, contentId),
      shelf.entries(context, contentId),
    ]);
    return reply.send(successEnvelope({ outstanding, entries }, request.id, CLIENT_WINDOW.current));
  });

  app.post(CONFLICT_RESOLVE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const { contentId, shelfEntryId } = request.params as { contentId: string; shelfEntryId: string };
    const parsed = parseConflictResolution(request.body, 'body');
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));

    const context = call(request);

    let resolvedBody;
    if (parsed.value.strategy === 'combine') {
      resolvedBody = parsed.value.resolvedBody ?? {};
    } else if (parsed.value.strategy === 'keep-theirs') {
      const current = await store.current(context, contentId);
      if (current === undefined) return reply.code(404).send(notFound(request));
      resolvedBody = current.body;
    } else {
      const shelved = (await shelf.entries(context, contentId))
        .filter(isShelved)
        .find((entry) => shelfKey(entry.contentId, entry.sequence) === shelfEntryId);
      if (shelved === undefined) return reply.code(404).send(notFound(request));
      resolvedBody = shelved.body;
    }

    try {
      const outcome = await shelf.resolveConflict(context, store, { contentId, shelfEntryId, resolvedBody });
      return reply.send(successEnvelope(outcome, request.id, CLIENT_WINDOW.current));
    } catch (error) {
      if (error instanceof ConflictError && error.kind === 'missing') return reply.code(404).send(notFound(request));
      if (error instanceof ConflictError && error.kind === 'state') {
        return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, error.message, request.id));
      }
      if (error instanceof RevisionError && error.kind === 'conflict') {
        return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, error.message, request.id));
      }
      throw error;
    }
  });
}
