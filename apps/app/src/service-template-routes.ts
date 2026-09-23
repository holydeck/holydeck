import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { instantiate, parseServiceTemplateDraft, parseTemplateInstantiation } from '@holydeck/contracts/service-templates';

import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { settled } from './refusals.js';
import { SERVICES_MANAGE, SERVICE_TEMPLATES_MANAGE } from './roles.js';
import { ServiceTemplateError, serviceTemplateContext } from './service-templates.js';
import { ServiceError, serviceContext } from './services.js';

import type { RouteNeed } from './authorization.js';
import type { Answer } from './refusals.js';
import type { ServiceTemplateStore } from './service-templates.js';
import type { ServiceItem } from '@holydeck/contracts/services';
import type { ServiceStore } from './services.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const SERVICE_TEMPLATE_PATH = '/api/v1/service-templates';
export const SERVICE_TEMPLATE_ID_PATH = `${SERVICE_TEMPLATE_PATH}/:id`;
export const SERVICE_TEMPLATE_INSTANTIATE_PATH = `${SERVICE_TEMPLATE_ID_PATH}/instantiate`;

const PERMISSION: RouteNeed = { kind: 'permission', need: SERVICE_TEMPLATES_MANAGE };
// The list alone is readable with `services.manage`, so an Editor building a New Service can offer
// Templates without also holding the Admin-only reach to define one.
const LIST_PERMISSION: RouteNeed = { kind: 'permission', need: SERVICES_MANAGE };
const INSTANTIATE_PERMISSION: RouteNeed = { kind: 'permission', need: SERVICES_MANAGE };

const ROUTES = [
  ['POST', SERVICE_TEMPLATE_PATH, PERMISSION],
  ['GET', SERVICE_TEMPLATE_PATH, LIST_PERMISSION],
  ['GET', SERVICE_TEMPLATE_ID_PATH, PERMISSION],
  ['POST', SERVICE_TEMPLATE_INSTANTIATE_PATH, INSTANTIATE_PERMISSION],
] as const;

type Refusal = 'schema' | 'state' | 'conflict';

// Both a template refusal and a service refusal (instantiation ends in `services.create`) share this
// shape and the same kinds, so one guard covers every `settled` call in this file.
const isRefusal = (error: unknown): error is (ServiceTemplateError | ServiceError) & { kind: Refusal } =>
  (error instanceof ServiceTemplateError || error instanceof ServiceError) && error.kind !== 'corrupt';

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
  readonly services: ServiceStore | undefined;
}

export function serveServiceTemplateRoutes(
  app: FastifyInstance,
  { serviceTemplates, services }: ServiceTemplateRoutesOptions,
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

  app.post(SERVICE_TEMPLATE_INSTANTIATE_PATH, { config: { need: INSTANTIATE_PERMISSION } }, async (request, reply) => {
    if (services === undefined) return reply.code(404).send(notFound(request));
    const parsed = parseTemplateInstantiation(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const preview = await serviceTemplates.preview(call(request), idIn(request));
    if (preview === undefined) return reply.code(404).send(notFound(request));
    const outcome = instantiate(preview.body, parsed.value.fills);
    if (!outcome.ok) {
      return reply.code(422).send(validationFailure(request.id, outcome.errors.map((error) => ({
        path: `fills.${error.entryId}`,
        code: error.kind === 'content-not-allowed' ? 'field.not_allowed' : 'field.required',
        message: error.message,
      }))));
    }
    const itemsById = new Map(outcome.items.map((item) => [item.id, item]));
    const sections = preview.body.sections.map((section) => ({
      id: section.id,
      name: section.name,
      items: section.entries
        .map((entry) => itemsById.get(entry.id))
        .filter((item): item is ServiceItem => item !== undefined),
    }));
    const answer = await settled(() => services.create(
      serviceContext(provenSession(request).record.actor, correlationFor('service:', request.id)),
      { title: parsed.value.title, date: parsed.value.date, site: parsed.value.site, sections },
    ), isRefusal);
    if (!answer.ok) return refused(request, reply, answer);
    return reply.code(201).send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });
}
