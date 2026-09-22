// Where the global slide-label catalogue is administered (spec LABL-01).
//
// Shaped like `slide-layout-routes.ts` minus boxes and revisions. `/catalogue` is gated narrower than
// the rest for the same reason content-language-routes.ts's is — it is what an Editor picks a label
// from, not what the catalogue is administered through.
//
// The one real difference: a claim here can collide with another label's name or shortcut. `create`,
// `edit`, and `unarchive` alone among the mutations grade the claim against the live catalogue, so only
// those three can answer 409 with the exact `CatalogueConflict[]` the store graded it against, carried
// in the envelope's `fields`. `archive` claims nothing and can only ever answer 409 for double-archiving.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { FIELD_CODES } from '@holydeck/contracts/problems';
import {
  SLIDE_LABELS_PATH,
  parseSlideLabelDraft,
  parseSlideLabelStatus,
  readableConflict,
} from '@holydeck/contracts/slide-labels';

import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { CATALOGUE_MANAGE, CONTENT_EDIT } from './roles.js';
import { SlideLabelError, slideLabelContext, subjectFor } from './slide-labels.js';

import type { AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { Identity } from './onboarding.js';
import type { SlideLabelStore } from './slide-labels.js';
import type { CatalogueConflict } from '@holydeck/contracts/slide-labels';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const SLIDE_LABEL_PREFIX = 'slideLabel:';

export const SLIDE_LABEL_ID_PATH = `${SLIDE_LABELS_PATH}/:id`;
export const SLIDE_LABEL_STATUS_PATH = `${SLIDE_LABEL_ID_PATH}/status`;
export const SLIDE_LABEL_CATALOGUE_PATH = `${SLIDE_LABELS_PATH}/catalogue`;

const PERMISSION: RouteNeed = { kind: 'permission', need: CATALOGUE_MANAGE };
const CATALOGUE_PERMISSION: RouteNeed = { kind: 'permission', need: CONTENT_EDIT };

const ROUTES = [
  ['GET', SLIDE_LABELS_PATH],
  ['POST', SLIDE_LABELS_PATH],
  ['GET', SLIDE_LABEL_CATALOGUE_PATH],
  ['GET', SLIDE_LABEL_ID_PATH],
  ['PUT', SLIDE_LABEL_ID_PATH],
  ['PATCH', SLIDE_LABEL_STATUS_PATH],
] as const;

const idIn = (request: FastifyRequest): string => (request.params as { readonly id: string }).id;

/** A store conflict travels here, not as an ad hoc message: each collision becomes one field problem. */
const conflictFields = (conflicts: readonly CatalogueConflict[]) =>
  conflicts.length === 0
    ? undefined
    : conflicts.map((conflict) => ({
        path: conflict.field,
        code: FIELD_CODES.notAllowed,
        message: readableConflict(conflict),
      }));

const refusalReply = (error: unknown, requestId: string) => {
  if (error instanceof SlideLabelError && (error.kind === 'state' || error.kind === 'conflict')) {
    return errorEnvelope(ENTITY_CONFLICT, error.message, requestId, conflictFields(error.conflicts));
  }
  throw error;
};

export interface SlideLabelRoutesOptions {
  readonly slideLabels: SlideLabelStore | undefined;
  readonly identity: Identity | undefined;
}

export function serveSlideLabelRoutes(app: FastifyInstance, { slideLabels, identity }: SlideLabelRoutesOptions): void {
  if (identity === undefined) {
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
  const labels = slideLabels as SlideLabelStore;
  const call = (request: FastifyRequest) =>
    slideLabelContext(provenSession(request).record.actor, correlationFor(SLIDE_LABEL_PREFIX, request.id));

  const note = async (request: FastifyRequest, id: string, outcome: AuditOutcome, detail: string): Promise<void> => {
    try {
      await identity.audit.record(
        auditContext(provenSession(request).record.actor, correlationFor(SLIDE_LABEL_PREFIX, request.id)),
        { action: 'content.change', subject: subjectFor(id), outcome, detail },
      );
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the slide label trail refused an entry');
    }
  };

  app.get(SLIDE_LABELS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const items = await labels.list(call(request));
    return reply.send(successEnvelope(items, request.id, CLIENT_WINDOW.current));
  });

  app.post(SLIDE_LABELS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSlideLabelDraft(request.body, 'slideLabel');
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    try {
      const created = await labels.create(call(request), parsed.value);
      await note(request, created.stamp.id, 'allowed', 'created');
      return reply.code(201).send(successEnvelope(created, request.id, CLIENT_WINDOW.current));
    } catch (error) {
      return reply.code(409).send(refusalReply(error, request.id));
    }
  });

  app.get(SLIDE_LABEL_CATALOGUE_PATH, { config: { need: CATALOGUE_PERMISSION } }, async (request, reply) => {
    const items = await labels.catalogue(call(request));
    return reply.send(successEnvelope(items, request.id, CLIENT_WINDOW.current));
  });

  app.get(SLIDE_LABEL_ID_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const item = await labels.get(call(request), idIn(request));
    if (item === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(item, request.id, CLIENT_WINDOW.current));
  });

  app.put(SLIDE_LABEL_ID_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSlideLabelDraft(request.body, 'slideLabel');
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = idIn(request);
    try {
      const edited = await labels.edit(call(request), id, parsed.value);
      if (edited === undefined) return reply.code(404).send(notFound(request));
      await note(request, id, 'allowed', 'edited');
      return reply.send(successEnvelope(edited, request.id, CLIENT_WINDOW.current));
    } catch (error) {
      return reply.code(409).send(refusalReply(error, request.id));
    }
  });

  app.patch(SLIDE_LABEL_STATUS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSlideLabelStatus(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = idIn(request);
    const context = call(request);
    try {
      const answer = parsed.value.archived ? await labels.archive(context, id) : await labels.unarchive(context, id);
      if (answer === undefined) return reply.code(404).send(notFound(request));
      await note(request, id, 'allowed', parsed.value.archived ? 'archived' : 'brought back');
      return reply.send(successEnvelope(answer, request.id, CLIENT_WINDOW.current));
    } catch (error) {
      return reply.code(409).send(refusalReply(error, request.id));
    }
  });
}
