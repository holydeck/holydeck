// Where an operator asks this deployment to back itself up right now, and what it has already
// recorded having done. Shaped like `media-routes.ts`: one permission, `BACKUP_MANAGE`, gates
// both routes, and a deployment with nowhere to keep a queue or a backup record serves the same
// path answering not-found — `main.ts` never constructs a `queue`/`db` pair for this module
// without an `identity` alongside it either, both coming from the same `mongoUrl !== ''` block.

import { parseBackupRequest } from '@holydeck/contracts/backups';
import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';

import { auditContext } from './audit.js';
import { BACKUP_RECORD, recordedBackups } from './backups.js';
import { correlationFor, requestContext } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { QUEUE_PERMISSIONS } from './queue.js';
import { permissionsFor } from './records.js';
import { BACKUP_MANAGE } from './roles.js';
import { localParts } from './schedule.js';

import type { AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { RequestContext } from './context.js';
import type { Identity } from './onboarding.js';
import type { Queue } from './queue.js';
import type { RepositoryDb } from './repositories.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const BACKUP_PREFIX = 'backup:';

export const BACKUPS_PATH = '/api/v1/backups';

const PERMISSION: RouteNeed = { kind: 'permission', need: BACKUP_MANAGE };

const ROUTES = [
  ['GET', BACKUPS_PATH],
  ['POST', BACKUPS_PATH],
] as const;

export interface BackupRoutesOptions {
  /** Absent whenever `identity` is, per `main.ts`'s wiring — never independently, from this module's view. */
  readonly db: RepositoryDb | undefined;
  readonly queue: Queue | undefined;
  /** Fixed clock: the same one `main.ts` wires the scheduler's own idempotency keys from. */
  readonly now: () => string;
  readonly timezone: string;
  readonly identity: Identity | undefined;
}

/** What this route needs beyond `backupContext`'s own grant (`backups.ts`): to see and enqueue a job. */
function routeContext(actor: string, correlationId: string): RequestContext {
  return requestContext({
    actor,
    permissions: [
      permissionsFor(BACKUP_RECORD).read,
      QUEUE_PERMISSIONS.enqueue,
      QUEUE_PERMISSIONS.read,
      permissionsFor('auditEvents').append,
    ],
    correlationId,
  });
}

export function serveBackupRoutes(app: FastifyInstance, { db, queue, now, timezone, identity }: BackupRoutesOptions): void {
  if (identity === undefined || db === undefined || queue === undefined) {
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

  const note = async (request: FastifyRequest, actor: string, subject: string, outcome: AuditOutcome): Promise<void> => {
    try {
      await identity.audit.record(auditContext(actor, correlationFor(BACKUP_PREFIX, request.id)), {
        action: 'backup.request',
        subject,
        outcome,
        detail: 'requested on demand',
      });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the backup trail refused an entry');
    }
  };

  app.get(BACKUPS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const actor = provenSession(request).record.actor;
    const context = routeContext(actor, correlationFor(BACKUP_PREFIX, request.id));
    const backups = await recordedBackups(db, context);
    return reply.send(successEnvelope({ backups }, request.id, CLIENT_WINDOW.current));
  });

  app.post(BACKUPS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseBackupRequest(request.body ?? {});
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));

    const actor = provenSession(request).record.actor;
    const context = routeContext(actor, correlationFor(BACKUP_PREFIX, request.id));

    const running = await queue.list(context, { kinds: ['backup-run'], states: ['leased'] });
    if (running.length > 0) {
      await note(request, actor, 'backup-run', 'refused');
      return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, 'a backup is already running', request.id));
    }

    const today = localParts(new Date(now()), timezone).date;
    const enqueued = await queue.enqueue(context, {
      kind: 'backup-run',
      idempotencyKey: `backup-run:${today}`,
      payload: { components: parsed.value.components, trigger: 'operator' },
    });
    await note(request, actor, 'backup-run', 'allowed');
    return reply.code(202).send(successEnvelope(enqueued, request.id, CLIENT_WINDOW.current));
  });
}
