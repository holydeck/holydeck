import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import {
  parseServiceDraft,
  parseServiceItem,
  parseServiceItemBody,
  parseServiceItemReorder,
  parseServiceItemRevision,
  parseServiceOutput,
  parseServiceSchedule,
  parseServiceStatus,
  parseServiceTransition,
} from '@holydeck/contracts/services';

import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { SERVICES_MANAGE } from './roles.js';
import { ServiceError, serviceContext } from './services.js';

import type { RouteNeed } from './authorization.js';
import type { ServiceStore } from './services.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const SERVICE_PATH = '/api/v1/services';
export const SERVICE_ID_PATH = `${SERVICE_PATH}/:id`;
export const SERVICE_CURRENT_PATH = `${SERVICE_PATH}/current`;
export const SERVICE_DUPLICATE_PATH = `${SERVICE_ID_PATH}/duplicate`;
export const SERVICE_SCHEDULE_PATH = `${SERVICE_ID_PATH}/schedule`;
export const SERVICE_TRANSITION_PATH = `${SERVICE_ID_PATH}/transition`;
export const SERVICE_STATUS_PATH = `${SERVICE_ID_PATH}/status`;
/** The optional output profile for one Service. */
export const SERVICE_OUTPUT_PATH = `${SERVICE_ID_PATH}/output`;
export const SERVICE_ITEMS_PATH = `${SERVICE_ID_PATH}/sections/:sectionId/items`;
export const SERVICE_ITEM_PATH = `${SERVICE_ID_PATH}/items/:itemId`;
export const SERVICE_ITEM_BODY_PATH = `${SERVICE_ITEM_PATH}/body`;
export const SERVICE_ITEM_ENABLE_PATH = `${SERVICE_ITEM_PATH}/enable`;
export const SERVICE_ITEM_DISABLE_PATH = `${SERVICE_ITEM_PATH}/disable`;
export const SERVICE_ITEM_DUPLICATE_PATH = `${SERVICE_ITEM_PATH}/duplicate`;
export const SERVICE_ITEMS_REORDER_PATH = `${SERVICE_ITEMS_PATH}/reorder`;
export const SERVICE_ITEM_REVISE_PATH = `${SERVICE_ITEM_PATH}/revise`;
export const SERVICE_CONTENT_DRIFT_PATH = `${SERVICE_ID_PATH}/content-drift`;
export const SERVICE_DEPENDENTS_PATH = `${SERVICE_ID_PATH}/dependents`;

const PERMISSION: RouteNeed = { kind: 'permission', need: SERVICES_MANAGE };

const ROUTES = [
  ['POST', SERVICE_PATH],
  ['GET', SERVICE_PATH],
  ['GET', SERVICE_CURRENT_PATH],
  ['GET', SERVICE_ID_PATH],
  ['POST', SERVICE_DUPLICATE_PATH],
  ['POST', SERVICE_SCHEDULE_PATH],
  ['POST', SERVICE_TRANSITION_PATH],
  ['PATCH', SERVICE_ID_PATH],
  ['PATCH', SERVICE_STATUS_PATH],
  ['PATCH', SERVICE_OUTPUT_PATH],
  ['POST', SERVICE_ITEMS_PATH],
  ['PUT', SERVICE_ITEM_BODY_PATH],
  ['DELETE', SERVICE_ITEM_PATH],
  ['POST', SERVICE_ITEM_ENABLE_PATH],
  ['POST', SERVICE_ITEM_DISABLE_PATH],
  ['POST', SERVICE_ITEM_DUPLICATE_PATH],
  ['POST', SERVICE_ITEMS_REORDER_PATH],
  ['POST', SERVICE_ITEM_REVISE_PATH],
  ['GET', SERVICE_CONTENT_DRIFT_PATH],
  ['GET', SERVICE_DEPENDENTS_PATH],
] as const;

const idIn = (request: FastifyRequest): string => (request.params as { readonly id: string }).id;
const sectionIdIn = (request: FastifyRequest): string =>
  (request.params as { readonly sectionId: string }).sectionId;
const itemIdIn = (request: FastifyRequest): string => (request.params as { readonly itemId: string }).itemId;

type Answer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: 'schema' | 'state' | 'conflict'; readonly message: string };

async function settled<T>(work: () => Promise<T>): Promise<Answer<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof ServiceError && error.kind !== 'corrupt') {
      return { ok: false, kind: error.kind, message: error.message };
    }
    throw error;
  }
}

const refused = (request: FastifyRequest, reply: FastifyReply, answer: Extract<Answer<never>, { ok: false }>) =>
  answer.kind === 'schema'
    ? reply.code(404).send(notFound(request))
    : reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));

export interface ServiceRoutesOptions {
  readonly services: ServiceStore | undefined;
}

export function serveServiceRoutes(app: FastifyInstance, { services }: ServiceRoutesOptions): void {
  if (services === undefined) {
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
    serviceContext(provenSession(request).record.actor, correlationFor('service:', request.id));

  app.post(SERVICE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseServiceDraft(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const answer = await settled(() => services.create(call(request), parsed.value));
    if (!answer.ok) return refused(request, reply, answer);
    return reply.code(201).send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SERVICE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const answer = await settled(() => services.list(call(request)));
    if (!answer.ok) return refused(request, reply, answer);
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SERVICE_CURRENT_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const context = call(request);
    const answer = await settled(async () => {
      const records = await services.list(context);
      const presenting = records.find((service) => service.state === 'presenting');
      return presenting === undefined ? undefined : services.current(context, presenting.stamp.id);
    });
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SERVICE_ID_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const answer = await settled(() => services.current(call(request), idIn(request)));
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.post(SERVICE_DUPLICATE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const answer = await settled(() => services.duplicate(call(request), idIn(request)));
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.code(201).send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.post(SERVICE_SCHEDULE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseServiceSchedule(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const answer = await settled(() => services.schedule(call(request), idIn(request), parsed.value.date));
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.post(SERVICE_TRANSITION_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseServiceTransition(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const answer = await settled(() => services.transition(call(request), idIn(request), parsed.value.state));
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.patch(SERVICE_ID_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseServiceDraft(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const answer = await settled(() => services.edit(call(request), idIn(request), parsed.value.sections));
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.patch(SERVICE_STATUS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseServiceStatus(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const context = call(request);
    const id = idIn(request);
    const answer = await settled(() =>
      parsed.value.archived ? services.archive(context, id) : services.unarchive(context, id),
    );
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.patch(SERVICE_OUTPUT_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseServiceOutput(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const answer = await settled(() => services.setOutput(call(request), idIn(request), parsed.value));
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.post(SERVICE_ITEMS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseServiceItem(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const answer = await settled(() =>
      services.addItem(call(request), idIn(request), sectionIdIn(request), parsed.value),
    );
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.put(SERVICE_ITEM_BODY_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseServiceItemBody(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const answer = await settled(() =>
      services.setItemBody(call(request), idIn(request), itemIdIn(request), parsed.value),
    );
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.delete(SERVICE_ITEM_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const answer = await settled(() => services.removeItem(call(request), idIn(request), itemIdIn(request)));
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.post(SERVICE_ITEM_ENABLE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const answer = await settled(() => services.enableItem(call(request), idIn(request), itemIdIn(request)));
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.post(SERVICE_ITEM_DISABLE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const answer = await settled(() => services.disableItem(call(request), idIn(request), itemIdIn(request)));
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.post(SERVICE_ITEM_DUPLICATE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const answer = await settled(() => services.duplicateItem(call(request), idIn(request), itemIdIn(request)));
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.post(SERVICE_ITEMS_REORDER_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseServiceItemReorder(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const answer = await settled(() =>
      services.reorderItems(call(request), idIn(request), sectionIdIn(request), parsed.value.itemIds),
    );
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.post(SERVICE_ITEM_REVISE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseServiceItemRevision(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const answer = await settled(() =>
      services.reviseItem(call(request), idIn(request), itemIdIn(request), parsed.value.revision),
    );
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SERVICE_CONTENT_DRIFT_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const answer = await settled(() => services.contentDrift(call(request), idIn(request)));
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  // Nothing downstream references a Service by id — always zero is the honest answer, not a stub.
  app.get(SERVICE_DEPENDENTS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const answer = await settled(() => services.current(call(request), idIn(request)));
    if (!answer.ok) return refused(request, reply, answer);
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope({ count: 0, approximate: true }, request.id, CLIENT_WINDOW.current));
  });
}
