// Where an operator asks this deployment to apply a recorded backup to production (OPS-06). Shaped like
// `backup-routes.ts`: one permission, `RESTORE_MANAGE`, gates the route, and a deployment with nowhere to
// keep a queue or a restore record serves the same path answering not-found.
//
// Applying a backup is not requesting one: the request is layered behind two independent checks before
// anything is queued. `parseRestoreRequest` already refuses a `confirm` that does not repeat `backupId`
// (the wrong-backup guard); this route adds a password re-check the same way `totp-routes.ts` and
// `passkey-routes.ts` ask one before giving up a second factor (the wrong-operator guard), and then a
// rehearsal precondition of its own — the one thing neither of those checks can stand in for, because a
// backup nobody has rehearsed restoring is a backup this deployment has no evidence restores at all.

import { accountIdIn } from '@holydeck/contracts/accounts';
import { parseRestoreRequest } from '@holydeck/contracts/backups';
import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';

import { passwordConfirmed } from './accounts.js';
import { auditContext } from './audit.js';
import { correlationFor, requestContext } from './context.js';
import { provenSession, refuseAsForbidden } from './csrf.js';
import { notFound } from './failures.js';
import { QUEUE_PERMISSIONS } from './queue.js';
import { permissionsFor } from './records.js';
import { repositoriesOn } from './repositories.js';
import { RESTORE_MANAGE } from './roles.js';
import { RESTORE_RECORD } from './restores.js';

import type { AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { RequestContext } from './context.js';
import type { Identity } from './onboarding.js';
import type { Queue } from './queue.js';
import type { RepositoryDb } from './repositories.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const RESTORE_PREFIX = 'restore:';

export const RESTORES_PATH = '/api/v1/restores';

const PERMISSION: RouteNeed = { kind: 'permission', need: RESTORE_MANAGE };

const ROUTES = [['POST', RESTORES_PATH]] as const;

const NOT_AN_ACCOUNT = 'applying a restore is asked by an account, and this session is not held by one';

/** How long a rehearsal of the requested backup keeps it eligible to apply. See this module's header. */
const REHEARSAL_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RestoreRoutesOptions {
  /** Absent whenever `identity` is, per `main.ts`'s wiring — never independently, from this module's view. */
  readonly db: RepositoryDb | undefined;
  readonly queue: Queue | undefined;
  /** Fixed clock: the same one every other route's idempotency key and audit entry is written from. */
  readonly now: () => string;
  readonly identity: Identity | undefined;
}

/** What this route needs beyond `restoreContext`'s own grant: to see a rehearsal and enqueue a job. */
function routeContext(actor: string, correlationId: string): RequestContext {
  return requestContext({
    actor,
    permissions: [
      permissionsFor(RESTORE_RECORD).read,
      QUEUE_PERMISSIONS.enqueue,
      permissionsFor('auditEvents').append,
    ],
    correlationId,
  });
}

export function serveRestoreRoutes(app: FastifyInstance, { db, queue, now, identity }: RestoreRoutesOptions): void {
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
      await identity.audit.record(auditContext(actor, correlationFor(RESTORE_PREFIX, request.id)), {
        action: 'restore.apply.request',
        subject,
        outcome,
        detail: 'requested a recorded backup be applied to production',
      });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the restore trail refused an entry');
    }
  };

  const asker = async (request: FastifyRequest, reply: FastifyReply): Promise<string | undefined> => {
    const id = accountIdIn(provenSession(request).record.actor);
    if (id === undefined) await refuseAsForbidden(request, reply, 'actor', NOT_AN_ACCOUNT);
    return id;
  };

  app.post(RESTORES_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseRestoreRequest(request.body ?? {});
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));

    const id = await asker(request, reply);
    if (id === undefined) return reply;

    const actor = provenSession(request).record.actor;
    const correlationId = correlationFor(RESTORE_PREFIX, request.id);

    if (!(await passwordConfirmed(identity, id, request.body, correlationId))) {
      await note(request, actor, parsed.value.backupId, 'refused');
      return reply.code(401).send(errorEnvelope(
        'auth.sign_in_refused', 'Confirm your password and try again in a few minutes.', request.id,
      ));
    }

    const context = routeContext(actor, correlationId);
    const since = new Date(Date.parse(now()) - REHEARSAL_WINDOW_MS).toISOString();
    const rehearsals = await repositoriesOn(db)[RESTORE_RECORD].read(context, {
      backupId: parsed.value.backupId,
      at: { $gte: since },
    });
    if (rehearsals.length === 0) {
      await note(request, actor, parsed.value.backupId, 'refused');
      return reply.code(409).send(errorEnvelope(
        ENTITY_CONFLICT,
        'this backup has no passing rehearsal in the last 24 hours',
        request.id,
      ));
    }

    const enqueued = await queue.enqueue(context, {
      kind: 'restore-apply',
      idempotencyKey: `restore-apply:${parsed.value.backupId}:${now()}`,
      payload: { backupId: parsed.value.backupId, components: parsed.value.components },
    });
    await note(request, actor, parsed.value.backupId, 'allowed');
    return reply.code(202).send(successEnvelope(enqueued, request.id, CLIENT_WINDOW.current));
  });
}
