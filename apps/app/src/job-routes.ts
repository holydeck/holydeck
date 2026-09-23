// Where an operator sees what the queue is doing and asks a failed job be tried again (OPS-08).
// Shaped like `backup-routes.ts`: a permission gates every route, and a deployment with nowhere to
// keep a queue serves the same paths answering not-found. Seeing and acting are gated apart here,
// unlike `backup-routes.ts`'s single `BACKUP_MANAGE`: `JOBS_READ` gates the two GET routes, `JOBS_MANAGE`
// gates requeuing, because `queue.ts` already grades `read` and `requeue` apart internally and OPS-08
// asks the same split of the route that fronts it.
//
// Listing and summarizing pass `Queue.list`/`Queue.summary` straight through with no cursor of their
// own — `Queue.list` keeps none, so this route keeps none either (a v1 follow-up, not this task's; no
// consumer reads a cursor yet, since no Jobs page exists). Requeuing looks a job up by `Queue.get`
// rather than paging through `Queue.list`, so a failed job outside the newest page is still found —
// scheduled-next times from the scheduler state doc are an `apps/worker`-owned read this route does not
// yet make (also a v1 follow-up, and again nothing here reads one back).

import { JOB_STATES } from '@holydeck/contracts/jobs';
import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope } from '@holydeck/contracts/http';

import { auditContext } from './audit.js';
import { correlationFor, requestContext } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { permissionsFor } from './records.js';
import { QUEUE_PERMISSIONS, QueueError } from './queue.js';
import { JOBS_MANAGE, JOBS_READ } from './roles.js';

import type { AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { RequestContext } from './context.js';
import type { Identity } from './onboarding.js';
import type { JobState } from '@holydeck/contracts/jobs';
import type { Queue } from './queue.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const JOB_PREFIX = 'job:';

// `restore-routes.ts` and `media-migration-routes.ts` each gate their own kind behind a check this route
// never re-runs: a fresh password step-up and a still-passing rehearsal for a restore, an unoverlapping
// target path for a migration. Requeuing either kind here would re-run a destructive production write past
// those checks on nothing but `JOBS_MANAGE`. Refused outright — the operator starts a fresh one through its
// own route instead, which re-earns the checks rather than skipping them.
const REQUEUE_REFUSED_KINDS = new Set(['restore-apply', 'media-root-migrate']);
const REQUEUE_REFUSED_MESSAGE =
  'This kind of job is not requeued here — start a new one through its own route so its checks run fresh.';

export const JOBS_PATH = '/api/v1/jobs';
const JOBS_SUMMARY_PATH = `${JOBS_PATH}/summary`;
const JOB_REQUEUE_PATH = `${JOBS_PATH}/:id/requeue`;

const READ_PERMISSION: RouteNeed = { kind: 'permission', need: JOBS_READ };
const MANAGE_PERMISSION: RouteNeed = { kind: 'permission', need: JOBS_MANAGE };

const ROUTES = [
  ['GET', JOBS_PATH, READ_PERMISSION],
  ['GET', JOBS_SUMMARY_PATH, READ_PERMISSION],
  ['POST', JOB_REQUEUE_PATH, MANAGE_PERMISSION],
] as const;

export interface JobRoutesOptions {
  /** Absent whenever `identity` is, per `main.ts`'s wiring — never independently, from this module's view. */
  readonly queue: Queue | undefined;
  readonly identity: Identity | undefined;
}

/** What every route here needs: to read the queue, to requeue a job, and to append what it did. */
function routeContext(actor: string, correlationId: string): RequestContext {
  return requestContext({
    actor,
    permissions: [QUEUE_PERMISSIONS.read, QUEUE_PERMISSIONS.requeue, permissionsFor('auditEvents').append],
    correlationId,
  });
}

type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/** The one refusal a caller can do something about: the job stopped being `failed` under them. */
async function settled<T>(work: () => Promise<T>): Promise<Answer<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof QueueError && error.kind === 'state') {
      return { ok: false, message: error.message };
    }
    throw error;
  }
}

const listOf = (value: string | undefined): readonly string[] | undefined =>
  value === undefined ? undefined : value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');

const KNOWN_STATE = new Set<string>(JOB_STATES);

const statesIn = (value: string | undefined): readonly JobState[] | undefined => {
  const parsed = listOf(value);
  return parsed?.filter((entry): entry is JobState => KNOWN_STATE.has(entry));
};

export function serveJobRoutes(app: FastifyInstance, { queue, identity }: JobRoutesOptions): void {
  // A deployment with nowhere to keep a queue has nothing here to show or to requeue. Every path is
  // still served, so the guard's table remains the complete shape of the surface in every deployment.
  if (identity === undefined || queue === undefined) {
    for (const [method, url, need] of ROUTES) {
      app.route({
        method,
        url,
        config: { need },
        handler: (request, reply) => reply.code(404).send(notFound(request)),
      });
    }
    return;
  }

  const note = async (request: FastifyRequest, actor: string, subject: string, outcome: AuditOutcome): Promise<void> => {
    try {
      await identity.audit.record(auditContext(actor, correlationFor(JOB_PREFIX, request.id)), {
        action: 'job.requeue',
        subject,
        outcome,
      });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the job trail refused an entry');
    }
  };

  app.get(JOBS_PATH, { config: { need: READ_PERMISSION } }, async (request, reply) => {
    const actor = provenSession(request).record.actor;
    const context = routeContext(actor, correlationFor(JOB_PREFIX, request.id));
    const query = request.query as { readonly kind?: string; readonly state?: string };
    const jobs = await queue.list(context, { kinds: listOf(query.kind), states: statesIn(query.state) });
    return reply.send(successEnvelope({ jobs }, request.id, CLIENT_WINDOW.current));
  });

  app.get(JOBS_SUMMARY_PATH, { config: { need: READ_PERMISSION } }, async (request, reply) => {
    const actor = provenSession(request).record.actor;
    const context = routeContext(actor, correlationFor(JOB_PREFIX, request.id));
    const summary = await queue.summary(context);
    return reply.send(successEnvelope({ summary }, request.id, CLIENT_WINDOW.current));
  });

  app.post(JOB_REQUEUE_PATH, { config: { need: MANAGE_PERMISSION } }, async (request, reply) => {
    const { id } = request.params as { readonly id: string };
    const actor = provenSession(request).record.actor;
    const context = routeContext(actor, correlationFor(JOB_PREFIX, request.id));

    const found = await queue.get(context, id);
    if (found === undefined || found.state !== 'failed') return reply.code(404).send(notFound(request));

    if (REQUEUE_REFUSED_KINDS.has(found.kind)) {
      await note(request, actor, id, 'refused');
      return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, REQUEUE_REFUSED_MESSAGE, request.id));
    }

    const answer = await settled(() => queue.requeue(context, { id, idempotencyKey: found.idempotencyKey }));
    if (!answer.ok) {
      await note(request, actor, id, 'refused');
      return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
    }
    await note(request, actor, id, 'allowed');
    return reply.code(200).send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });
}
