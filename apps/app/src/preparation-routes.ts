import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { type Parsed, parseObject } from '@holydeck/contracts/problems';
import { parsePreparationInputs } from '@holydeck/contracts/snapshots';

import { correlationFor } from './context.js';
import { FORBIDDEN, provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { PRESENTATION_CONTROL, SERVICES_MANAGE } from './roles.js';
import { PreparationError, preparationContext } from './snapshots.js';

import type { RouteNeed } from './authorization.js';
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

const parseOverrideBody = (value: unknown): Parsed<OverrideBody> =>
  parseObject(value, 'override', (reader) => ({ runId: reader.text('runId'), reason: reader.text('reason') }));

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
}

export function servePreparationRoutes(app: FastifyInstance, { preparation }: PreparationRoutesOptions): void {
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
