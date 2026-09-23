// Where Service Templates are defined, previewed, saved forward, archived and brought back, and where a
// Service already run is converted into one (spec TMPL-04, AUTH-09).
//
// Shaped like `slide-layout-routes.ts`: one permission, `SERVICE_TEMPLATES_MANAGE`, gates every route but
// the list, which an Editor may also read under `services.manage` alone (see `service-templates.ts`'s own
// context for why). A deployment with nowhere to keep an identity serves the same paths answering
// not-found — nothing here to audit a change against. Reading is never audited; a change that actually
// happened is, exactly once — creating stays on the shared `content.change` action every other content
// surface uses, but saving forward, archiving, bringing back and converting from a Service each get their
// own action instead, with the direction said in the detail beside archive/unarchive rather than in two.
//
// `/status` is whether a Template is offered at all; the bare id path saved with PUT is what it is built
// from. Saving entries onto an archived Template is refused rather than quietly bringing it back, which is
// the same refusal `service-templates.ts` gets from the stamp underneath it. `/from-service` mints a new
// Template from an existing Service's own sections and items — a creation, not a change to either — so it
// is named for what it reads rather than nested under the Template it produces, which does not exist yet.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { FIELD_CODES } from '@holydeck/contracts/problems';
import {
  instantiate,
  parseServiceTemplateDraft,
  parseServiceTemplateName,
  parseServiceTemplateStatus,
  parseTemplateInstantiation,
} from '@holydeck/contracts/service-templates';

import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { settled } from './refusals.js';
import { SERVICES_MANAGE, SERVICE_TEMPLATES_MANAGE } from './roles.js';
import { ServiceTemplateError, serviceTemplateContext, subjectFor } from './service-templates.js';
import { ServiceError, serviceContext } from './services.js';

import type { AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { Answer } from './refusals.js';
import type { Identity } from './onboarding.js';
import type { ServiceTemplateStore } from './service-templates.js';
import type { ServiceItem } from '@holydeck/contracts/services';
import type { ServiceStore } from './services.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const TEMPLATE_PREFIX = 'serviceTemplate:';

export const SERVICE_TEMPLATE_PATH = '/api/v1/service-templates';

/** One Service Template: its stamp, its name and the entries of whichever revision was asked for. */
export const SERVICE_TEMPLATE_ID_PATH = `${SERVICE_TEMPLATE_PATH}/:id`;
export const SERVICE_TEMPLATE_INSTANTIATE_PATH = `${SERVICE_TEMPLATE_ID_PATH}/instantiate`;

/** Its entries over time: what each ordinal is, and never what is in it. */
export const SERVICE_TEMPLATE_REVISIONS_PATH = `${SERVICE_TEMPLATE_ID_PATH}/revisions`;

/** Whether it is offered where Templates are chosen. Its entries are untouched either way. */
export const SERVICE_TEMPLATE_STATUS_PATH = `${SERVICE_TEMPLATE_ID_PATH}/status`;

/** A new Template minted from an existing Service's own sections and items. The Service is only read. */
export const SERVICE_TEMPLATE_FROM_SERVICE_PATH = `${SERVICE_TEMPLATE_PATH}/from-service/:serviceId`;

const PERMISSION: RouteNeed = { kind: 'permission', need: SERVICE_TEMPLATES_MANAGE };
// The list alone is readable with `services.manage`, so an Editor building a New Service can offer
// Templates without also holding the Admin-only reach to define one.
const LIST_PERMISSION: RouteNeed = { kind: 'permission', need: SERVICES_MANAGE };
const INSTANTIATE_PERMISSION: RouteNeed = { kind: 'permission', need: SERVICES_MANAGE };

/** Every route this module serves, in the order it registers them. */
const ROUTES = [
  ['GET', SERVICE_TEMPLATE_PATH, LIST_PERMISSION],
  ['POST', SERVICE_TEMPLATE_PATH, PERMISSION],
  ['GET', SERVICE_TEMPLATE_ID_PATH, PERMISSION],
  ['PUT', SERVICE_TEMPLATE_ID_PATH, PERMISSION],
  ['GET', SERVICE_TEMPLATE_REVISIONS_PATH, PERMISSION],
  ['PATCH', SERVICE_TEMPLATE_STATUS_PATH, PERMISSION],
  ['POST', SERVICE_TEMPLATE_FROM_SERVICE_PATH, PERMISSION],
  ['POST', SERVICE_TEMPLATE_INSTANTIATE_PATH, INSTANTIATE_PERMISSION],
] as const;

/** Counting from one, the same as history does. A leading zero is not an ordinal anything wrote. */
const ORDINAL = /^[1-9][0-9]*$/u;

const ordinalIn = (value: unknown): number | undefined =>
  typeof value === 'string' && ORDINAL.test(value) ? Number(value) : undefined;

const NOT_AN_ORDINAL = [
  { path: 'revision', code: FIELD_CODES.notANumber, message: 'must be an ordinal counting from one' },
];

const idIn = (request: FastifyRequest): string => (request.params as { readonly id: string }).id;
const serviceIdIn = (request: FastifyRequest): string =>
  (request.params as { readonly serviceId: string }).serviceId;

/**
 * The two refusals a caller can do something about — the state moved under them, or another writer got
 * there first — told apart from the two nobody can. A schema refusal cannot reach here, because every
 * payload below was graded before the store saw it; a corrupt record is this server's own fault. Both of
 * those stay thrown, and are answered as faults rather than as something the caller should correct.
 */
const isRefusal = (error: unknown): error is ServiceTemplateError & { kind: 'state' | 'conflict' } =>
  error instanceof ServiceTemplateError && (error.kind === 'state' || error.kind === 'conflict');

type InstantiateRefusal = 'schema' | 'state' | 'conflict';

// Both a template refusal and a service refusal (instantiation ends in `services.create`) share this
// shape and the same kinds, so one guard covers every `settled` call the instantiate route makes.
const isInstantiateRefusal = (
  error: unknown,
): error is (ServiceTemplateError | ServiceError) & { kind: InstantiateRefusal } =>
  (error instanceof ServiceTemplateError || error instanceof ServiceError) && error.kind !== 'corrupt';

// `schema` reaches here because instantiation's fills are graded against a Template's blanks after this
// route's own body parsing, not before it, unlike every other write in this file.
const refused = (
  request: FastifyRequest,
  reply: FastifyReply,
  answer: Extract<Answer<never, InstantiateRefusal>, { ok: false }>,
) =>
  answer.kind === 'schema'
    ? reply.code(422).send(validationFailure(request.id, [{ path: '', code: 'invalid', message: answer.message }]))
    : reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));

export interface ServiceTemplateRoutesOptions {
  /** Absent whenever `identity` is, per `main.ts`'s wiring — never independently, from this module's view. */
  readonly serviceTemplates: ServiceTemplateStore | undefined;
  /** Absent in a deployment that keeps no identity, which has nothing here to audit a change against. */
  readonly identity: Identity | undefined;
  readonly services: ServiceStore | undefined;
}

export function serveServiceTemplateRoutes(
  app: FastifyInstance,
  { serviceTemplates, identity, services }: ServiceTemplateRoutesOptions,
): void {
  // A deployment with nowhere to keep an identity, or no Service Template store, has nothing here to
  // audit or serve. `main.ts` always wires the two together, but `buildApp` accepts them as independent
  // options, so this module checks both itself rather than trusting that pairing. Every path is still
  // served, so the guard's table remains the complete shape of the surface in every deployment.
  if (identity === undefined || serviceTemplates === undefined) {
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

  const templates = serviceTemplates;

  const call = (request: FastifyRequest) =>
    serviceTemplateContext(provenSession(request).record.actor, correlationFor(TEMPLATE_PREFIX, request.id));

  /**
   * Written after the change, and logged rather than answered when the trail refuses it: a Template that
   * was created or saved forward holds that, whether or not this server managed to write it down.
   */
  const note = async (
    request: FastifyRequest,
    action: 'content.change' | 'serviceTemplate.version' | 'serviceTemplate.archive' | 'serviceTemplate.unarchive' | 'serviceTemplate.fromService',
    id: string,
    outcome: AuditOutcome,
    detail: string,
  ): Promise<void> => {
    try {
      await identity.audit.record(
        auditContext(provenSession(request).record.actor, correlationFor(TEMPLATE_PREFIX, request.id)),
        { action, subject: subjectFor(id), outcome, detail },
      );
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the Service Template trail refused an entry');
    }
  };

  app.get(SERVICE_TEMPLATE_PATH, { config: { need: LIST_PERMISSION } }, async (request, reply) => {
    const answer = await settled(() => templates.list(call(request)), isRefusal);
    if (!answer.ok) return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.post(SERVICE_TEMPLATE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseServiceTemplateDraft(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const answer = await settled(() => templates.create(call(request), parsed.value), isRefusal);
    if (!answer.ok) return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
    await note(request, 'content.change', answer.value.stamp.id, 'allowed', 'created');
    return reply.code(201).send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SERVICE_TEMPLATE_ID_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const asked = (request.query as { readonly revision?: string }).revision;
    const revision = ordinalIn(asked);
    if (asked !== undefined && revision === undefined) {
      return reply.code(422).send(validationFailure(request.id, NOT_AN_ORDINAL));
    }
    const preview = await templates.preview(call(request), idIn(request), revision);
    // One answer for a Template nobody created and an ordinal it never had: both are a thing this server
    // does not have, and telling them apart would say which identifiers exist.
    if (preview === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(preview, request.id, CLIENT_WINDOW.current));
  });

  app.put(SERVICE_TEMPLATE_ID_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseServiceTemplateDraft(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = idIn(request);
    const answer = await settled(() => templates.version(call(request), id, parsed.value), isRefusal);
    if (!answer.ok) return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    // A save that changed neither the entries nor the name is not a change, and the trail is a record of
    // changes — but a rename alone still writes a stamp row, so it is still worth an entry.
    if (answer.value.appended) {
      await note(request, 'serviceTemplate.version', id, 'allowed', `saved revision ${answer.value.revision}`);
    } else if (answer.value.renamed) {
      await note(request, 'serviceTemplate.version', id, 'allowed', 'renamed');
    }
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(SERVICE_TEMPLATE_REVISIONS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const history = await templates.history(call(request), idIn(request));
    // A Template that exists has at least the revision it was created with, so an empty history is a
    // Template nobody created rather than one with nothing in it.
    if (history.length === 0) return reply.code(404).send(notFound(request));
    const listed = history.map((record) => ({
      revision: record.revision,
      at: record.at,
      actor: record.actor,
      origin: record.origin,
    }));
    return reply.send(successEnvelope({ revisions: listed }, request.id, CLIENT_WINDOW.current));
  });

  app.patch(SERVICE_TEMPLATE_STATUS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseServiceTemplateStatus(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = idIn(request);
    const context = call(request);
    const answer = await settled(
      () => (parsed.value.archived ? templates.archive(context, id) : templates.unarchive(context, id)),
      isRefusal,
    );
    if (!answer.ok) return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    // The direction is in the detail as well as in the action, so either alone still says which happened.
    await note(
      request,
      parsed.value.archived ? 'serviceTemplate.archive' : 'serviceTemplate.unarchive',
      id,
      'allowed',
      parsed.value.archived ? 'archived' : 'brought back',
    );
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.post(SERVICE_TEMPLATE_FROM_SERVICE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseServiceTemplateName(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const serviceId = serviceIdIn(request);
    const answer = await settled(
      () => templates.fromService(call(request), serviceId, parsed.value.name),
      isRefusal,
    );
    if (!answer.ok) return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
    // A Service nobody created and a Template nobody may build from it are the same not-found: this server
    // is not saying which Services exist any more than the id route above says which Templates do.
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    await note(request, 'serviceTemplate.fromService', answer.value.stamp.id, 'allowed', `converted from ${serviceId}`);
    return reply.code(201).send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.post(SERVICE_TEMPLATE_INSTANTIATE_PATH, { config: { need: INSTANTIATE_PERMISSION } }, async (request, reply) => {
    if (services === undefined) return reply.code(404).send(notFound(request));
    const parsed = parseTemplateInstantiation(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const preview = await templates.preview(call(request), idIn(request));
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
    ), isInstantiateRefusal);
    if (!answer.ok) return refused(request, reply, answer);
    return reply.code(201).send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });
}
