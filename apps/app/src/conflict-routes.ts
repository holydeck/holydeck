// The conflict shelf's own surface: what is still waiting to be settled for one piece of content, and the
// one way an editor settles it (spec v1c-09, COLL-01). Strategy resolution lives here rather than in
// `conflicts.ts`: `keep-mine` and `keep-theirs` both read a body this route already has to fetch anyway —
// the shelved entry, or the standing revision — and `combine` carries the body the client already
// resolved by hand, so `resolveConflict()` only ever receives the one body it is to save, never has to
// choose between three.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { isShelved, parseConflictResolution, shelfKey } from '@holydeck/contracts/collaboration';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';

import { auditContext } from './audit.js';
import { ConflictError, SHELF_PERMISSIONS } from './conflicts.js';
import { contentKindGate } from './content-kind.js';
import { correlationFor, requestContext } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { REVISION_PERMISSIONS, RevisionError } from './revisions.js';
import { CONTENT_EDIT, LAYOUTS_MANAGE, SERVICE_TEMPLATES_MANAGE } from './roles.js';

import type { RouteNeed } from './authorization.js';
import type { ConflictShelf, ResolutionOutcome } from './conflicts.js';
import type { ContentKindOf } from './content-kind.js';
import type { Identity } from './onboarding.js';
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
  /** Where a resolution is recorded. Without one, the resolution still happens; nothing notes it happened. */
  readonly identity?: Identity | undefined;
  /** Which kind an id is. Absent, every id is ordinary content, which still needs content editing. */
  readonly kindOf?: ContentKindOf;
}

export function serveConflictRoutes(
  app: FastifyInstance,
  { conflictShelf, revisions, identity, kindOf }: ConflictRoutesOptions,
): void {
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

  const admitted = contentKindGate({ identity, kindOf, prefix: CONFLICT_PREFIX, what: 'conflicts' });

  /**
   * Written after the resolution, and logged rather than answered when the trail refuses it: a
   * resolution holds that it happened, whether or not this server managed to write it down.
   */
  const note = async (request: FastifyRequest, contentId: string, strategy: string, outcome: ResolutionOutcome) => {
    if (identity === undefined) return;
    try {
      await identity.audit.record(
        auditContext(provenSession(request).record.actor, correlationFor(CONFLICT_PREFIX, request.id)),
        {
          action: 'content.conflict.resolve',
          subject: contentId,
          outcome: 'allowed',
          detail: `${strategy}: revision ${String(outcome.revision.revision)} over revision ${String(outcome.over)}`,
        },
      );
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the conflict trail refused an entry');
    }
  };

  app.get(CONFLICTS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const { contentId } = request.params as { contentId: string };
    if (!(await admitted(request, reply, contentId))) return reply;
    const context = call(request);
    const [outstanding, entries] = await Promise.all([
      shelf.outstanding(context, contentId),
      shelf.entries(context, contentId),
    ]);
    return reply.send(successEnvelope({ outstanding, entries }, request.id, CLIENT_WINDOW.current));
  });

  app.post(CONFLICT_RESOLVE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const { contentId, shelfEntryId } = request.params as { contentId: string; shelfEntryId: string };
    if (!(await admitted(request, reply, contentId))) return reply;
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
      await note(request, contentId, parsed.value.strategy, outcome);
      return reply.send(successEnvelope(outcome, request.id, CLIENT_WINDOW.current));
    } catch (error) {
      if (error instanceof ConflictError && error.kind === 'missing') return reply.code(404).send(notFound(request));
      // A shelf this code cannot read is a defect, but one the editor is standing in front of: saying so as a
      // conflict keeps their unsaved work on screen, where a 500 would read as "try again" and lose nothing new.
      if (error instanceof ConflictError && (error.kind === 'state' || error.kind === 'corrupt')) {
        return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, error.message, request.id));
      }
      if (error instanceof RevisionError && error.kind === 'conflict') {
        return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, error.message, request.id));
      }
      throw error;
    }
  });
}
