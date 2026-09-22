import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { FIELD_CODES, type Parsed, parseObject } from '@holydeck/contracts/problems';
import { parsePreparationInputs } from '@holydeck/contracts/snapshots';

import { correlationFor } from './context.js';
import { FORBIDDEN, provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { PRESENTATION_CONTROL, SERVICES_MANAGE } from './roles.js';
import { runContext } from './runs.js';
import { PreparationError, preparationContext } from './snapshots.js';

import type { RouteNeed } from './authorization.js';
import type { RunStore } from './runs.js';
import type { PreparationStore } from './snapshots.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const PREPARATION_PREPARE_PATH = '/api/v1/services/:id/prepare';
export const PREPARATION_PREPARED_PATH = '/api/v1/services/:id/prepared';
export const PREPARATION_READINESS_PATH = '/api/v1/services/:id/readiness';
export const PREPARATION_OVERRIDE_PATH = '/api/v1/services/:id/override';

const MANAGE_PERMISSION: RouteNeed = { kind: 'permission', need: SERVICES_MANAGE };
const CONTROL_PERMISSION: RouteNeed = { kind: 'permission', need: PRESENTATION_CONTROL };

const ROUTES = [
  ['POST', PREPARATION_PREPARE_PATH, MANAGE_PERMISSION],
  ['GET', PREPARATION_PREPARED_PATH, MANAGE_PERMISSION],
  ['GET', PREPARATION_READINESS_PATH, MANAGE_PERMISSION],
  ['POST', PREPARATION_OVERRIDE_PATH, CONTROL_PERMISSION],
] as const;

interface OverrideBody {
  readonly runId: string;
  readonly reason: string;
}

// The separator belongs to the immutable event key, never to a run's own name: accepting it here would
// make two distinct run and sequence pairs spell one stored `_id`. Keep the route's boundary narrower
// than the key it will later construct, and leave the reason's human-readable emptiness to the store.
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/u;

const parseOverrideBody = (value: unknown): Parsed<OverrideBody> =>
  parseObject(value, 'override', (reader) => {
    const runId = reader.text('runId');
    if (!RUN_ID.test(runId)) reader.reject('runId', FIELD_CODES.notAllowed, 'must be 1 to 64 letters, digits, hyphens or underscores');
    return { runId, reason: reader.text('reason') };
  });

type Answer<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly kind: 'schema' | 'permission' | 'state' | 'reason' | 'conflict';
      readonly message: string;
    };

async function settled<T>(work: () => Promise<T>): Promise<Answer<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof PreparationError && error.kind !== 'corrupt') {
      return { ok: false, kind: error.kind, message: error.message };
    }
    throw error;
  }
}

const refused = (request: FastifyRequest, reply: FastifyReply, answer: Extract<Answer<never>, { ok: false }>) => {
  if (answer.kind === 'schema' || answer.kind === 'reason') {
    return reply.code(422).send(validationFailure(request.id, [{ path: '', code: 'invalid', message: answer.message }]));
  }
  if (answer.kind === 'permission') return reply.code(403).send(errorEnvelope(FORBIDDEN, answer.message, request.id));
  return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
};

export interface PreparationRoutesOptions {
  readonly preparation: PreparationStore | undefined;
  /** The run a caller-supplied `runId` belongs to (D-8) — absent in a deployment with no durable run
   *  store, where the ownership check below is skipped and this route behaves as it always has. */
  readonly runs: Pick<RunStore, 'resume'> | undefined;
}

export function servePreparationRoutes(app: FastifyInstance, { preparation, runs }: PreparationRoutesOptions): void {
  if (preparation === undefined) {
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

  const call = (request: FastifyRequest, prefix: string) =>
    preparationContext(provenSession(request).record.actor, correlationFor(prefix, request.id));
  const idIn = (request: FastifyRequest): string => (request.params as { readonly id: string }).id;

  app.post(PREPARATION_PREPARE_PATH, { config: { need: MANAGE_PERMISSION } }, async (request, reply) => {
    const parsed = parsePreparationInputs(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const answer = await settled(() => preparation.prepare(call(request, 'prepare:'), idIn(request), parsed.value));
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(PREPARATION_PREPARED_PATH, { config: { need: MANAGE_PERMISSION } }, async (request, reply) => {
    const answer = await settled(() => preparation.prepared(call(request, 'prepared:'), idIn(request)));
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(PREPARATION_READINESS_PATH, { config: { need: MANAGE_PERMISSION } }, async (request, reply) => {
    const answer = await settled(() => preparation.readiness(call(request, 'readiness:'), idIn(request)));
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.post(PREPARATION_OVERRIDE_PATH, { config: { need: CONTROL_PERMISSION } }, async (request, reply) => {
    const parsed = parseOverrideBody(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    // D-8: this route takes a caller-supplied runId with no ownership of its own — closed here rather
    // than inside `preparation.override` itself, the same gap `runs.ts`'s own `start` closes by minting
    // the runId it overrides under, never accepting one from a caller.
    if (runs !== undefined) {
      // `call`'s own preparationContext carries `snapshots.ts`'s permissions, not `presentationRuns.read`
      // — `runContext` is `runs.ts`'s own read context, the one its `resume` actually needs to answer.
      const readContext = runContext(provenSession(request).record.actor, correlationFor('override:', request.id));
      const row = await runs.resume(readContext, parsed.value.runId);
      if (row === undefined || row.serviceId !== idIn(request)) {
        return reply
          .code(409)
          .send(errorEnvelope(ENTITY_CONFLICT, `${parsed.value.runId} does not belong to ${idIn(request)}`, request.id));
      }
    }
    const session = {
      actor: provenSession(request).record.actor,
      permissions: provenSession(request).record.permissions,
      correlationId: correlationFor('override:', request.id),
    };
    const answer = await settled(() => preparation.override(session, { serviceId: idIn(request), ...parsed.value }));
    if (!answer.ok) return refused(request, reply, answer);
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });
}
