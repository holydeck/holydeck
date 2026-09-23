// Where Slide Layouts are created, previewed, saved forward, archived and brought back (spec TMPL-01).
//
// Shaped like `accounts-routes.ts`: one permission, `LAYOUTS_MANAGE`, gates every route, and a deployment
// with nowhere to keep an identity serves the same paths answering not-found — nothing here to audit a
// change against. Reading is never audited, the same as any other GET; a change that actually happened is,
// exactly once, and the entry names what happened and never the boxes it happened to.
//
// The two things a Layout is made of are administered through two different shapes on purpose, because
// they are two different decisions: `/boxes` and `/revisions` are its content over time, `/status` is
// whether it is offered at all. Saving boxes onto an archived Layout is refused rather than quietly
// bringing it back, which is the same refusal `slide-layouts.ts` gets from the stamp underneath it.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import {
  SLIDE_LAYOUTS_PATH,
  parseSlideLayoutBody,
  parseSlideLayoutDraft,
  parseSlideLayoutStatus,
} from '@holydeck/contracts/layouts';
import { FIELD_CODES } from '@holydeck/contracts/problems';

import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { libraryContext } from './library.js';
import { settled } from './refusals.js';
import { CONTENT_EDIT, LAYOUTS_MANAGE } from './roles.js';
import { slideGroupContext } from './slide-groups.js';
import { SlideLayoutError, slideLayoutContext, subjectFor } from './slide-layouts.js';

import type { AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { LibraryStore } from './library.js';
import type { Identity } from './onboarding.js';
import type { SlideGroupStore } from './slide-groups.js';
import type { SlideLayoutStore } from './slide-layouts.js';
import type { RevisionRecord } from '@holydeck/contracts/revisions';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const LAYOUT_PREFIX = 'layout:';

/** One Slide Layout: its stamp, its name and the boxes of whichever revision was asked for. */
export const LAYOUT_PATH = `${SLIDE_LAYOUTS_PATH}/:id`;

/** The boxes it holds, saved forward. A save that changes nothing appends nothing. */
export const LAYOUT_BOXES_PATH = `${LAYOUT_PATH}/boxes`;

/** Its content history: what each ordinal is, and never what is in it. */
export const LAYOUT_REVISIONS_PATH = `${LAYOUT_PATH}/revisions`;

/** Where an earlier ordinal is brought back — by appending it again, never by rewriting anything. */
const LAYOUT_REVISION_PATH = `${LAYOUT_REVISIONS_PATH}/:revision`;

/** Whether it is offered where Layouts are chosen. Its boxes are untouched either way. */
const LAYOUT_STATUS_PATH = `${LAYOUT_PATH}/status`;

/** An approximate count of what references it. Never audited — it mutates nothing. */
const LAYOUT_DEPENDENTS_PATH = `${LAYOUT_PATH}/dependents`;

const PERMISSION: RouteNeed = { kind: 'permission', need: LAYOUTS_MANAGE };
const LIST_PERMISSION: RouteNeed = { kind: 'any-permission', needs: [CONTENT_EDIT, LAYOUTS_MANAGE] };

/** Every route this module serves, in the order it registers them. */
const ROUTES = [
  ['GET', SLIDE_LAYOUTS_PATH, LIST_PERMISSION],
  ['POST', SLIDE_LAYOUTS_PATH, PERMISSION],
  ['GET', LAYOUT_PATH, PERMISSION],
  ['GET', LAYOUT_REVISIONS_PATH, PERMISSION],
  ['PUT', LAYOUT_BOXES_PATH, PERMISSION],
  ['POST', LAYOUT_REVISION_PATH, PERMISSION],
  ['PATCH', LAYOUT_STATUS_PATH, PERMISSION],
  ['GET', LAYOUT_DEPENDENTS_PATH, PERMISSION],
] as const;

/** Counting from one, the same as history does. A leading zero is not an ordinal anything wrote. */
const ORDINAL = /^[1-9][0-9]*$/u;

const ordinalIn = (value: unknown): number | undefined =>
  typeof value === 'string' && ORDINAL.test(value) ? Number(value) : undefined;

const NOT_AN_ORDINAL = [
  { path: 'revision', code: FIELD_CODES.notANumber, message: 'must be an ordinal counting from one' },
];

const idIn = (request: FastifyRequest): string => (request.params as { readonly id: string }).id;

/** What history says about a revision without saying what is in it: the boxes are read through preview. */
const listed = (record: RevisionRecord) => ({
  revision: record.revision,
  at: record.at,
  actor: record.actor,
  origin: record.origin,
});

/**
 * The two refusals a caller can do something about — the state moved under them, or another writer got
 * there first — told apart from the two nobody can. A schema refusal cannot reach here, because every
 * payload below was graded before the store saw it; a corrupt record is this server's own fault. Both of
 * those stay thrown, and are answered as faults rather than as something the caller should correct.
 */
const isRefusal = (error: unknown): error is SlideLayoutError & { kind: 'state' | 'conflict' } =>
  error instanceof SlideLayoutError && (error.kind === 'state' || error.kind === 'conflict');

export interface SlideLayoutRoutesOptions {
  /** Absent whenever `identity` is, per `main.ts`'s wiring — never independently, from this module's view. */
  readonly slideLayouts: SlideLayoutStore | undefined;
  /** Absent in a deployment that keeps no identity, which has nothing here to audit a change against. */
  readonly identity: Identity | undefined;
  /** Absent whenever `identity` is, per `main.ts`'s wiring — used only for the dependents scan below. */
  readonly slideGroups: SlideGroupStore | undefined;
  readonly library: LibraryStore | undefined;
}

export function serveSlideLayoutRoutes(
  app: FastifyInstance,
  { slideLayouts, identity, slideGroups: slideGroupsOption, library: libraryOption }: SlideLayoutRoutesOptions,
): void {
  // A deployment with nowhere to keep an identity has nothing here to audit a change against. Every path
  // is still served, so the guard's table remains the complete shape of the surface in every deployment.
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

  // Guaranteed by `main.ts`'s wiring, not by this module: an `identity` never exists without a Layout
  // store alongside it, so the gate above is this module's only check for either.
  const layouts = slideLayouts as SlideLayoutStore;
  const slideGroups = slideGroupsOption as SlideGroupStore;
  const library = libraryOption as LibraryStore;

  const call = (request: FastifyRequest) =>
    slideLayoutContext(provenSession(request).record.actor, correlationFor(LAYOUT_PREFIX, request.id));

  app.get(SLIDE_LAYOUTS_PATH, { config: { need: LIST_PERMISSION } }, async (request, reply) => {
    const all = await layouts.list(call(request));
    const held = provenSession(request).record.permissions;
    const asked = (request.query as { readonly archived?: string }).archived === 'true';
    const showArchived = held.includes(LAYOUTS_MANAGE) && asked;
    const items = showArchived ? all : all.filter((row) => row.stamp.archivedAt === undefined);
    return reply.send(successEnvelope(items, request.id, CLIENT_WINDOW.current));
  });

  /**
   * Written after the change, and logged rather than answered when the trail refuses it: a Layout that was
   * created or saved forward holds that, whether or not this server managed to write it down. One action
   * for all of them — the content surface has one — with the direction in the detail beside it.
   */
  const note = async (
    request: FastifyRequest,
    id: string,
    outcome: AuditOutcome,
    detail: string,
  ): Promise<void> => {
    try {
      await identity.audit.record(
        auditContext(provenSession(request).record.actor, correlationFor(LAYOUT_PREFIX, request.id)),
        { action: 'content.change', subject: subjectFor(id), outcome, detail },
      );
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the Slide Layout trail refused an entry');
    }
  };

  app.post(SLIDE_LAYOUTS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSlideLayoutDraft(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const answer = await settled(() => layouts.create(call(request), parsed.value), isRefusal);
    if (!answer.ok) return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
    await note(request, answer.value.stamp.id, 'allowed', 'created');
    return reply.code(201).send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.get(LAYOUT_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const asked = (request.query as { readonly revision?: string }).revision;
    const revision = ordinalIn(asked);
    if (asked !== undefined && revision === undefined) {
      return reply.code(422).send(validationFailure(request.id, NOT_AN_ORDINAL));
    }
    const preview = await layouts.preview(call(request), idIn(request), revision);
    // One answer for a Layout nobody created and an ordinal it never had: both are a thing this server
    // does not have, and telling them apart would say which identifiers exist.
    if (preview === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(preview, request.id, CLIENT_WINDOW.current));
  });

  app.get(LAYOUT_REVISIONS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const history = await layouts.history(call(request), idIn(request));
    // A Layout that exists has at least the revision it was created with, so an empty history is a Layout
    // nobody created rather than one with nothing in it.
    if (history.length === 0) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope({ revisions: history.map(listed) }, request.id, CLIENT_WINDOW.current));
  });

  app.put(LAYOUT_BOXES_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSlideLayoutBody(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = idIn(request);
    const answer = await settled(() => layouts.version(call(request), id, parsed.value), isRefusal);
    if (!answer.ok) return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    // A save that changed nothing is not a change, and the trail is a record of changes.
    if (answer.value.appended) await note(request, id, 'allowed', `saved revision ${answer.value.revision}`);
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  app.post(LAYOUT_REVISION_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const revision = ordinalIn((request.params as { readonly revision: string }).revision);
    if (revision === undefined) return reply.code(422).send(validationFailure(request.id, NOT_AN_ORDINAL));
    const id = idIn(request);
    const answer = await settled(() => layouts.restoreVersion(call(request), id, revision), isRefusal);
    if (!answer.ok) return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    const restored = answer.value;
    if (restored.appended) {
      await note(request, id, 'allowed', `restored revision ${restored.from} as revision ${restored.revision}`);
    }
    return reply.send(successEnvelope(restored, request.id, CLIENT_WINDOW.current));
  });

  app.patch(LAYOUT_STATUS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseSlideLayoutStatus(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = idIn(request);
    const context = call(request);
    const answer = await settled(
      () => (parsed.value.archived ? layouts.archive(context, id) : layouts.unarchive(context, id)),
      isRefusal,
    );
    if (!answer.ok) return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, answer.message, request.id));
    if (answer.value === undefined) return reply.code(404).send(notFound(request));
    // The direction is in the detail rather than in two actions, because the content surface names one.
    await note(request, id, 'allowed', parsed.value.archived ? 'archived' : 'brought back');
    return reply.send(successEnvelope(answer.value, request.id, CLIENT_WINDOW.current));
  });

  // An approximate count, not an audited action: a substring scan over every slide group's and reusable
  // slide's body, the same crude-but-honest shape `content-language-routes.ts` and `media-routes.ts` use
  // for theirs.
  app.get(LAYOUT_DEPENDENTS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const id = idIn(request);
    const preview = await layouts.preview(call(request), id);
    if (preview === undefined) return reply.code(404).send(notFound(request));
    const actor = provenSession(request).record.actor;
    const correlationId = correlationFor(LAYOUT_PREFIX, request.id);
    const [groupRows, reusableRows] = await Promise.all([
      library.list(libraryContext(actor, correlationId), { kind: 'slideGroup' }),
      library.list(libraryContext(actor, correlationId), { kind: 'reusableSlide' }),
    ]);
    const records = await Promise.all(
      [...groupRows, ...reusableRows].map((row) => slideGroups.current(slideGroupContext(actor, correlationId), row.stamp.id)),
    );
    const count = records
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
      .filter((record) => JSON.stringify(record.body).includes(id)).length;
    return reply.send(successEnvelope({ count, approximate: true }, request.id, CLIENT_WINDOW.current));
  });
}
