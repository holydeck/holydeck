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
//
// The administered list carries each label's usage, and `/dependents` answers the same number exactly
// (COLAB-13/14): how many current songs, slide groups and reusable slides carry a section or slide whose
// label names it. Content stores a label by its name, not its id — the editors offer the catalogue as a
// datalist — so the match is on the name, trimmed and case-folded by `labelKey`. See content-usage.ts.

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
import { contentUsage, labelKey } from './content-usage.js';
import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { CATALOGUE_MANAGE, CONTENT_EDIT } from './roles.js';
import { SlideLabelError, slideLabelContext, subjectFor } from './slide-labels.js';

import type { AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { LibraryStore } from './library.js';
import type { Identity } from './onboarding.js';
import type { SermonStore } from './sermons.js';
import type { SlideGroupStore } from './slide-groups.js';
import type { SlideLabelStore } from './slide-labels.js';
import type { SongStore } from './songs.js';
import type { CatalogueConflict } from '@holydeck/contracts/slide-labels';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const SLIDE_LABEL_PREFIX = 'slideLabel:';

export const SLIDE_LABEL_ID_PATH = `${SLIDE_LABELS_PATH}/:id`;
export const SLIDE_LABEL_STATUS_PATH = `${SLIDE_LABEL_ID_PATH}/status`;
export const SLIDE_LABEL_CATALOGUE_PATH = `${SLIDE_LABELS_PATH}/catalogue`;
export const SLIDE_LABEL_DEPENDENTS_PATH = `${SLIDE_LABEL_ID_PATH}/dependents`;

const PERMISSION: RouteNeed = { kind: 'permission', need: CATALOGUE_MANAGE };
const CATALOGUE_PERMISSION: RouteNeed = { kind: 'permission', need: CONTENT_EDIT };

const ROUTES = [
  ['GET', SLIDE_LABELS_PATH, PERMISSION],
  ['POST', SLIDE_LABELS_PATH, PERMISSION],
  ['GET', SLIDE_LABEL_CATALOGUE_PATH, CATALOGUE_PERMISSION],
  ['GET', SLIDE_LABEL_ID_PATH, PERMISSION],
  ['PUT', SLIDE_LABEL_ID_PATH, PERMISSION],
  ['PATCH', SLIDE_LABEL_STATUS_PATH, PERMISSION],
  ['GET', SLIDE_LABEL_DEPENDENTS_PATH, PERMISSION],
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
  /** Absent whenever `identity` is, per `main.ts`'s wiring — used only for the usage counts below. */
  readonly songs: SongStore | undefined;
  readonly slideGroups: SlideGroupStore | undefined;
  readonly library: LibraryStore | undefined;
  /** Absent in a deployment without sermons; a sermon carries no labels, so nothing here reads it yet. */
  readonly sermons?: SermonStore | undefined;
}

export function serveSlideLabelRoutes(
  app: FastifyInstance,
  { slideLabels, identity, songs, slideGroups, library, sermons }: SlideLabelRoutesOptions,
): void {
  if (identity === undefined) {
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
  const labels = slideLabels as SlideLabelStore;
  const usageFor = (request: FastifyRequest) =>
    contentUsage(
      { library: library as LibraryStore, songs: songs as SongStore, slideGroups: slideGroups as SlideGroupStore, sermons },
      provenSession(request).record.actor,
      correlationFor(SLIDE_LABEL_PREFIX, request.id),
    );
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
    const [items, usage] = await Promise.all([labels.list(call(request)), usageFor(request)]);
    const counted = items.map((item) => ({ ...item, usage: usage.labels.get(labelKey(item.name)) ?? 0 }));
    return reply.send(successEnvelope(counted, request.id, CLIENT_WINDOW.current));
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

  // Exact, not approximate: every current item is read (see the header), so the count is the true one.
  app.get(SLIDE_LABEL_DEPENDENTS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const item = await labels.get(call(request), idIn(request));
    if (item === undefined) return reply.code(404).send(notFound(request));
    const count = (await usageFor(request)).labels.get(labelKey(item.name)) ?? 0;
    return reply.send(successEnvelope({ count, approximate: false }, request.id, CLIENT_WINDOW.current));
  });
}
