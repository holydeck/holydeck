// The content library over HTTP (spec CONT-01), and archiving from it (DELT-01, COLAB-14).
//
// Archive and restore are one `PATCH …/status` route for every library kind, since the library stamp is
// the one place a song, sermon, reading, slide group or reusable slide is archived — its body and
// revisions stay where they are. Before a person confirms, the Archive dialog asks `/dependents`: how many
// live Services and Service Templates hold an entry pointing at the item. That count is exact — every live
// Service and the standing entries of every live Template are read — and an archived Service or Template
// is not counted, since archiving the item cannot surprise anyone through one nobody is using.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { LIBRARY_PATH, parseLibraryFilter, parseLibraryStatus } from '@holydeck/contracts/library';

import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { LibraryError, libraryContext, subjectFor } from './library.js';
import { CONTENT_EDIT } from './roles.js';
import { serviceTemplateContext } from './service-templates.js';
import { serviceContext } from './services.js';

import type { AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { LibraryStore } from './library.js';
import type { Identity } from './onboarding.js';
import type { ServiceTemplateStore } from './service-templates.js';
import type { ServiceStore } from './services.js';
import type { LibraryDependents } from '@holydeck/contracts/library';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const LIBRARY_PREFIX = 'library:';
export const LIBRARY_ID_PATH = `${LIBRARY_PATH}/:id`;
export const LIBRARY_STATUS_PATH = `${LIBRARY_ID_PATH}/status`;
export const LIBRARY_DEPENDENTS_PATH = `${LIBRARY_ID_PATH}/dependents`;
const ROUTES = [
  ['GET', LIBRARY_PATH],
  ['GET', LIBRARY_ID_PATH],
  ['PATCH', LIBRARY_STATUS_PATH],
  ['GET', LIBRARY_DEPENDENTS_PATH],
] as const;
const PERMISSION: RouteNeed = { kind: 'permission', need: CONTENT_EDIT };
const idIn = (request: FastifyRequest): string => (request.params as { readonly id: string }).id;

export interface LibraryRoutesOptions {
  readonly library: LibraryStore | undefined;
  readonly identity: Identity | undefined;
  /** Read only for `/dependents`; a deployment without either counts none of that kind. */
  readonly services?: ServiceStore | undefined;
  readonly serviceTemplates?: ServiceTemplateStore | undefined;
}

export function serveLibraryRoutes(
  app: FastifyInstance,
  { library, identity, services, serviceTemplates }: LibraryRoutesOptions,
): void {
  if (identity === undefined) {
    for (const [method, url] of ROUTES) {
      app.route({ method, url, config: { need: PERMISSION }, handler: (request, reply) => reply.code(404).send(notFound(request)) });
    }
    return;
  }
  const store = library as LibraryStore;
  const actorOf = (request: FastifyRequest): string => provenSession(request).record.actor;
  const correlation = (request: FastifyRequest): string => correlationFor(LIBRARY_PREFIX, request.id);
  const call = (request: FastifyRequest) => libraryContext(actorOf(request), correlation(request));

  const note = async (request: FastifyRequest, id: string, outcome: AuditOutcome, detail: string): Promise<void> => {
    try {
      await identity.audit.record(auditContext(actorOf(request), correlation(request)), {
        action: 'content.change',
        subject: subjectFor(id),
        outcome,
        detail,
      });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the library trail refused an entry');
    }
  };

  /** Live Services with any item, and live Templates with any standing entry, whose content is `id`. */
  const dependentsOf = async (request: FastifyRequest, id: string): Promise<LibraryDependents> => {
    const liveServices = (await services?.list(serviceContext(actorOf(request), correlation(request)))) ?? [];
    const usingServices = liveServices.filter(
      (service) =>
        service.stamp.archivedAt === undefined &&
        service.sections.some((section) => section.items.some((item) => item.content?.id === id)),
    ).length;
    let usingTemplates = 0;
    if (serviceTemplates !== undefined) {
      const context = serviceTemplateContext(actorOf(request), correlation(request));
      for (const template of await serviceTemplates.list(context)) {
        if (template.stamp.archivedAt !== undefined) continue;
        const standing = await serviceTemplates.preview(context, template.stamp.id);
        const uses = standing?.body.sections.some((section) => section.entries.some((entry) => entry.slot === 'fixed' && entry.content?.id === id));
        if (uses === true) usingTemplates += 1;
      }
    }
    return { count: usingServices + usingTemplates, approximate: false, services: usingServices, templates: usingTemplates };
  };

  app.get(LIBRARY_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseLibraryFilter(request.query, 'library');
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const items = await store.list(call(request), parsed.value);
    return reply.send(successEnvelope(items, request.id, CLIENT_WINDOW.current));
  });

  app.get(LIBRARY_ID_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const item = await store.get(call(request), idIn(request));
    if (item === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(item, request.id, CLIENT_WINDOW.current));
  });

  app.patch(LIBRARY_STATUS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseLibraryStatus(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = idIn(request);
    try {
      const answer = parsed.value.archived ? await store.archive(call(request), id) : await store.restore(call(request), id);
      if (answer === undefined) return reply.code(404).send(notFound(request));
      await note(request, id, 'allowed', parsed.value.archived ? 'archived' : 'restored');
      return reply.send(successEnvelope(answer, request.id, CLIENT_WINDOW.current));
    } catch (error) {
      if (error instanceof LibraryError && error.kind === 'state') {
        return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, error.message, request.id));
      }
      throw error;
    }
  });

  app.get(LIBRARY_DEPENDENTS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const id = idIn(request);
    if ((await store.get(call(request), id)) === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(await dependentsOf(request, id), request.id, CLIENT_WINDOW.current));
  });
}
