import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { parseServiceTemplateDraft } from '@holydeck/contracts/service-templates';

import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { SERVICE_TEMPLATES_MANAGE } from './roles.js';
import { ServiceTemplateError, serviceTemplateContext } from './service-templates.js';

import type { RouteNeed } from './authorization.js';
import type { ServiceTemplateStore } from './service-templates.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const SERVICE_TEMPLATE_PATH = '/api/v1/service-templates';
export const SERVICE_TEMPLATE_ID_PATH = `${SERVICE_TEMPLATE_PATH}/:id`;

const PERMISSION: RouteNeed = { kind: 'permission', need: SERVICE_TEMPLATES_MANAGE };

const ROUTES = [
  ['POST', SERVICE_TEMPLATE_PATH],
  ['GET', SERVICE_TEMPLATE_PATH],
  ['GET', SERVICE_TEMPLATE_ID_PATH],
] as const;

type Answer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: 'schema' | 'state' | 'conflict'; readonly message: string };

async function settled<T>(work: () => Promise<T>): Promise<Answer<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof ServiceTemplateError && error.kind !== 'corrupt') {
      return { ok: false, kind: error.kind, message: error.message };
    }
    throw error;
  }
}

// `state` is not currently thrown by these store methods, but remains a conflict mapping for their interface.
const refused = (request: FastifyRequest, reply: FastifyReply, answer: Extract<Answer<never>, { ok: false }>) =>
  answer.kind === 'schema'
    ? reply.code(422).send(validationFailure(request.id, [{ path: '', code: 'invalid', message: answer.message }]))
    : reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));

export interface ServiceTemplateRoutesOptions {
  readonly serviceTemplates: ServiceTemplateStore | undefined;
}

export function serveServiceTemplateRoutes(
  app: FastifyInstance,
  { serviceTemplates }: ServiceTemplateRoutesOptions,
): void {
  if (serviceTemplates === undefined) {
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

  const call = (request: FastifyRequest) =>
    serviceTemplateContext(provenSession(request).record.actor, correlationFor('serviceTemplate:', request.id));
  const idIn = (request: FastifyRequest): string => (request.params as { readonly id: string }).id;

  app.post(SERVICE_TEMPLATE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseServiceTemplateDraft(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const answer = await settled(() => serviceTemplates.create(call(request), parsed.value));
    if (!answer.ok) return refused(request, reply, answer);
    return reply.code(201).send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SERVICE_TEMPLATE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const answer = await settled(() => serviceTemplates.list(call(request)));
    if (!answer.ok) return refused(request, reply, answer);
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SERVICE_TEMPLATE_ID_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const answer = await settled(() => serviceTemplates.preview(call(request), idIn(request)));
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });
}
