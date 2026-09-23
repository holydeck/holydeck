// Where an operator asks this deployment to migrate its media storage to a new root, and later
// clears the old root once the switch has proven itself (OPS-16). Shaped like `restore-routes.ts`:
// one permission gates both routes, and a deployment with nowhere to keep an identity or a queue
// serves the same paths answering not-found.
//
// Neither route adds a conflict guard of its own beyond `guardMaintenance`, which already refuses
// every mutating request — including a second trigger — for as long as a migration is actually
// running (the lease the worker's handler holds). The narrow gap between this route enqueuing a
// job and the worker claiming it and acquiring that lease is left unguarded on purpose: a route-
// side check would race the same way, and the worst a race here can do is queue a second migration
// that runs after the first, chained from whatever root the first one left `mediaRoot` at — not
// data loss, since Ruling 2/6/7's copy-verify-then-switch order makes that outcome safe either way.
//
// The cleanup route deletes a known-good duplicate of what is already live and verified — `fromRoot`
// is confirmed-redundant data at that point, an entirely different safety class from deleting a
// possibly-still-referenced media asset — so it is a plain recursive removal, not routed through
// any retention/guardRemoval machinery.

import { rm } from 'node:fs/promises';

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { parseMediaMigrationRequest } from '@holydeck/contracts/media-migration';

import { auditContext } from './audit.js';
import { correlationFor, requestContext } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { QUEUE_PERMISSIONS } from './queue.js';
import { permissionsFor } from './records.js';
import { MEDIA_MANAGE } from './roles.js';

import type { AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { RequestContext } from './context.js';
import type { MediaMigrationStateStore } from './media-migration-state.js';
import type { Identity } from './onboarding.js';
import type { Queue } from './queue.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const MEDIA_MIGRATION_PREFIX = 'media-migration:';

export const MEDIA_MIGRATION_PATH = '/api/v1/media/storage-migration';
export const MEDIA_MIGRATION_CLEANUP_PATH = `${MEDIA_MIGRATION_PATH}/cleanup`;

const PERMISSION: RouteNeed = { kind: 'permission', need: MEDIA_MANAGE };

/** Every route this module serves, in the order it registers them. */
const ROUTES = [
  ['POST', MEDIA_MIGRATION_PATH],
  ['POST', MEDIA_MIGRATION_CLEANUP_PATH],
] as const;

export interface MediaMigrationRoutesOptions {
  /** Absent whenever `identity` is, per `main.ts`'s wiring — never independently, from this module's view. */
  readonly queue: Queue | undefined;
  readonly migrationState: MediaMigrationStateStore | undefined;
  readonly now: () => string;
  readonly identity: Identity | undefined;
}

/** What the trigger route needs beyond `auditContext`'s own grant: to enqueue a job. */
function routeContext(actor: string, correlationId: string): RequestContext {
  return requestContext({
    actor,
    permissions: [QUEUE_PERMISSIONS.enqueue, permissionsFor('auditEvents').append],
    correlationId,
  });
}

export function serveMediaMigrationRoutes(
  app: FastifyInstance,
  { queue, migrationState, now, identity }: MediaMigrationRoutesOptions,
): void {
  // A deployment with nowhere to keep an identity has nothing here to audit a migration against.
  // Every path is still served, so the guard's table remains the complete shape of the surface in
  // every deployment.
  if (identity === undefined || queue === undefined || migrationState === undefined) {
    for (const [method, url] of ROUTES) {
      app.route({
        method,
        url,
        config: { need: PERMISSION },
        handler: (request, reply) => reply.code(404).send(notFound(request)),
      });
    }
    return;
  }

  const note = async (
    request: FastifyRequest,
    action: 'media.storageMigration.request' | 'media.storageMigration.cleanup',
    actor: string,
    subject: string,
    outcome: AuditOutcome,
    detail: string,
  ): Promise<void> => {
    try {
      await identity.audit.record(auditContext(actor, correlationFor(MEDIA_MIGRATION_PREFIX, request.id)), {
        action,
        subject,
        outcome,
        detail,
      });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the media migration trail refused an entry');
    }
  };

  app.post(MEDIA_MIGRATION_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseMediaMigrationRequest(request.body ?? {});
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));

    const actor = provenSession(request).record.actor;
    const correlationId = correlationFor(MEDIA_MIGRATION_PREFIX, request.id);
    const context = routeContext(actor, correlationId);

    const enqueued = await queue.enqueue(context, {
      kind: 'media-root-migrate',
      idempotencyKey: `media-root-migrate:${parsed.value.targetRoot}:${now()}`,
      payload: { targetRoot: parsed.value.targetRoot },
    });
    await note(
      request,
      'media.storageMigration.request',
      actor,
      parsed.value.targetRoot,
      'allowed',
      'requested a media storage-root migration',
    );
    return reply.code(202).send(successEnvelope(enqueued, request.id, CLIENT_WINDOW.current));
  });

  app.post(MEDIA_MIGRATION_CLEANUP_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const record = await migrationState.read();
    if (record === undefined || record.cleanedUpAt !== undefined) {
      return reply.code(409).send(
        errorEnvelope(ENTITY_CONFLICT, 'no completed migration is waiting to be cleaned up', request.id),
      );
    }

    const actor = provenSession(request).record.actor;
    await rm(record.fromRoot, { recursive: true, force: true });
    const cleanedUpAt = now();
    await migrationState.recordCleanup(cleanedUpAt);
    await note(
      request,
      'media.storageMigration.cleanup',
      actor,
      record.fromRoot,
      'allowed',
      'cleaned up the previous media root after a migration',
    );
    return reply.code(200).send(
      successEnvelope({ fromRoot: record.fromRoot, cleanedUpAt }, request.id, CLIENT_WINDOW.current),
    );
  });
}
