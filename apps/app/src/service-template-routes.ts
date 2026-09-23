import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { parseServiceTemplateDraft } from '@holydeck/contracts/service-templates';

import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { settled } from './refusals.js';
import { SERVICES_MANAGE, SERVICE_TEMPLATES_MANAGE } from './roles.js';
import { ServiceTemplateError, serviceTemplateContext } from './service-templates.js';

import type { RouteNeed } from './authorization.js';
import type { Answer } from './refusals.js';
import type { ServiceTemplateStore } from './service-templates.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const SERVICE_TEMPLATE_PATH = '/api/v1/service-templates';
export const SERVICE_TEMPLATE_ID_PATH = `${SERVICE_TEMPLATE_PATH}/:id`;

const PERMISSION: RouteNeed = { kind: 'permission', need: SERVICE_TEMPLATES_MANAGE };
// The list alone is readable with `services.manage`, so an Editor building a New Service can offer
// Templates without also holding the Admin-only reach to define one.
const LIST_PERMISSION: RouteNeed = { kind: 'permission', need: SERVICES_MANAGE };

const ROUTES = [
  ['POST', SERVICE_TEMPLATE_PATH, PERMISSION],
  ['GET', SERVICE_TEMPLATE_PATH, LIST_PERMISSION],
  ['GET', SERVICE_TEMPLATE_ID_PATH, PERMISSION],
] as const;

type Refusal = 'schema' | 'state' | 'conflict';

const isRefusal = (error: unknown): error is ServiceTemplateError & { kind: Refusal } =>
  error instanceof ServiceTemplateError && error.kind !== 'corrupt';

// `state` is not currently thrown by these store methods, but remains a conflict mapping for their interface.
const refused = (
  request: FastifyRequest,
  reply: FastifyReply,
  answer: Extract<Answer<never, Refusal>, { ok: false }>,
) =>
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

  const call = (request: FastifyRequest) =>
    serviceTemplateContext(provenSession(request).record.actor, correlationFor('serviceTemplate:', request.id));
  const idIn = (request: FastifyRequest): string => (request.params as { readonly id: string }).id;

  app.post(SERVICE_TEMPLATE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseServiceTemplateDraft(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const answer = await settled(() => serviceTemplates.create(call(request), parsed.value), isRefusal);
    if (!answer.ok) return refused(request, reply, answer);
    return reply.code(201).send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SERVICE_TEMPLATE_PATH, { config: { need: LIST_PERMISSION } }, async (request, reply) => {
    const answer = await settled(() => serviceTemplates.list(call(request)), isRefusal);
    if (!answer.ok) return refused(request, reply, answer);
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SERVICE_TEMPLATE_ID_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const answer = await settled(() => serviceTemplates.preview(call(request), idIn(request)), isRefusal);
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });
}
