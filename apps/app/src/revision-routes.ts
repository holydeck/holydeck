// The history behind a piece of content: what has been saved, one revision compared with another, and
// an earlier one brought back (spec v1c-09, COLAB-02). `revisions.ts` keys every revision by content id
// alone, so the route itself asks which kind an id belongs to before it answers anything about it: a
// Slide Layout's history is as much Admin's as the Layout is, and holding history alone opens nothing
// the session could not already edit. No conflict handling: a restore this route offers
// has already read the revision it names, so the only way `RevisionStore.restore()` could still refuse
// it is a race this code cannot correct by retrying, and is answered as the fault it is.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { parseRevisionCompareQuery } from '@holydeck/contracts/revisions';
import { diffRevisions } from '@holydeck/core/diff-revisions';

import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { provenSession, refuseAsForbidden } from './csrf.js';
import { notFound } from './failures.js';
import { revisionContext } from './revisions.js';
import { CONTENT_EDIT, CONTENT_HISTORY_MANAGE, LAYOUTS_MANAGE, SERVICE_TEMPLATES_MANAGE } from './roles.js';
import { serviceTemplateContext } from './service-templates.js';
import { slideLayoutContext } from './slide-layouts.js';

import type { RouteNeed } from './authorization.js';
import type { Identity } from './onboarding.js';
import type { RevisionStore } from './revisions.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const REVISION_PREFIX = 'revision:';
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const REVISION_NUMBER = /^[1-9][0-9]*$/u;

export const REVISIONS_PATH = '/api/v1/content/:contentId/revisions';
export const REVISION_COMPARE_PATH = '/api/v1/content/:contentId/revisions/compare';
export const REVISION_PATH = '/api/v1/content/:contentId/revisions/:revision';
export const REVISION_RESTORE_PATH = '/api/v1/content/:contentId/revisions/:revision/restore';

const PERMISSION: RouteNeed = { kind: 'permission', need: CONTENT_HISTORY_MANAGE };

const ROUTES = [
  ['GET', REVISIONS_PATH],
  ['GET', REVISION_COMPARE_PATH],
  ['GET', REVISION_PATH],
  ['POST', REVISION_RESTORE_PATH],
] as const;

/** Which surface a revised id belongs to — and so which permission it is administered under. */
export type RevisedKind = 'slideLayout' | 'serviceTemplate' | 'content';

/** The permission each kind already asks of its own routes; the history of one asks exactly the same. */
const KIND_PERMISSION: Readonly<Record<RevisedKind, string>> = {
  slideLayout: LAYOUTS_MANAGE,
  serviceTemplate: SERVICE_TEMPLATES_MANAGE,
  content: CONTENT_EDIT,
};

export type ContentKindOf = (contentId: string, actor: string, correlationId: string) => Promise<RevisedKind>;

/** Anything that can say whether it holds an id: the two Admin-only stores both answer `preview()`. */
interface Previewing {
  preview(context: unknown, id: string): Promise<unknown>;
}

/**
 * Asks the stores that own an Admin-only kind whether they hold the id, and reads anything neither
 * holds as ordinary content — the strictest reading an unknown id can have without refusing Admin.
 */
export function contentKindResolver(stores: {
  readonly slideLayouts: Previewing | undefined;
  readonly serviceTemplates: Previewing | undefined;
}): ContentKindOf {
  return async (contentId, actor, correlationId) => {
    if ((await stores.slideLayouts?.preview(slideLayoutContext(actor, correlationId), contentId)) !== undefined) {
      return 'slideLayout';
    }
    if ((await stores.serviceTemplates?.preview(serviceTemplateContext(actor, correlationId), contentId)) !== undefined) {
      return 'serviceTemplate';
    }
    return 'content';
  };
}

function revisionNumberIn(raw: string): number | undefined {
  return REVISION_NUMBER.test(raw) ? Number(raw) : undefined;
}

export interface RevisionRoutesOptions {
  readonly revisions: RevisionStore | undefined;
  /** Where the restore below is recorded. Without one, the restore still happens; nothing notes it happened. */
  readonly identity: Identity | undefined;
  /** Which kind an id is. Absent, every id is ordinary content, which still needs content editing. */
  readonly kindOf?: ContentKindOf;
}

export function serveRevisionRoutes(
  app: FastifyInstance,
  { revisions, identity, kindOf = () => Promise.resolve('content') }: RevisionRoutesOptions,
): void {
  if (revisions === undefined) {
    for (const [method, url] of ROUTES) {
      app.route({
        method,
        url,
        config: { need: PERMISSION },
        handler: (request: FastifyRequest, reply: FastifyReply) => reply.code(404).send(notFound(request)),
      });
    }
    return;
  }

  const store = revisions;

  const call = (request: FastifyRequest) =>
    revisionContext(provenSession(request).record.actor, correlationFor(REVISION_PREFIX, request.id));

  /**
   * Written after the restore, and logged rather than answered when the trail refuses it: a restore
   * holds that it happened, whether or not this server managed to write it down.
   */
  /**
   * Whether the session may see this id's history at all, answered and recorded as the guard's own
   * refusal when it may not: the same 403, the same `authorization.refuse` entry, one layer further in.
   */
  const admitted = async (request: FastifyRequest, reply: FastifyReply, contentId: string): Promise<boolean> => {
    const { actor, permissions } = provenSession(request).record;
    const need = KIND_PERMISSION[await kindOf(contentId, actor, correlationFor(REVISION_PREFIX, request.id))];
    if (permissions.includes(need)) return true;
    const detail = `this content's history needs ${need}`;
    if (identity !== undefined) {
      try {
        await identity.audit.record(auditContext(actor, correlationFor(REVISION_PREFIX, request.id)), {
          action: 'authorization.refuse',
          subject: `${request.method} ${String(request.routeOptions.url)}`,
          outcome: 'refused',
          detail,
        });
      } catch (error: unknown) {
        request.log.error({ err: error }, 'the revision trail refused an entry');
      }
    }
    await refuseAsForbidden(request, reply, 'permission', detail);
    return false;
  };

  const note = async (request: FastifyRequest, actor: string, contentId: string, number: number): Promise<void> => {
    if (identity === undefined) return;
    try {
      await identity.audit.record(auditContext(actor, correlationFor(REVISION_PREFIX, request.id)), {
        action: 'content.revision.restore',
        subject: contentId,
        outcome: 'allowed',
        detail: `restored revision ${String(number)}`,
      });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the revision trail refused an entry');
    }
  };

  app.get(REVISIONS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const { contentId } = request.params as { contentId: string };
    if (!(await admitted(request, reply, contentId))) return reply;
    const context = call(request);
    const full = await store.history(context, contentId);
    if (full.length === 0) return reply.code(404).send(notFound(request));

    const query = request.query as Record<string, string | undefined>;
    const limitRaw = query['limit'];
    const limit =
      limitRaw !== undefined && REVISION_NUMBER.test(limitRaw)
        ? Math.min(Number(limitRaw), MAX_LIST_LIMIT)
        : DEFAULT_LIST_LIMIT;
    const beforeRaw = query['before'];
    const before = beforeRaw !== undefined ? revisionNumberIn(beforeRaw) : undefined;

    const descending = [...full].reverse();
    const windowed = before === undefined ? descending : descending.filter((entry) => entry.revision < before);
    return reply.send(successEnvelope(windowed.slice(0, limit), request.id, CLIENT_WINDOW.current));
  });

  app.get(REVISION_COMPARE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const { contentId } = request.params as { contentId: string };
    if (!(await admitted(request, reply, contentId))) return reply;
    const parsed = parseRevisionCompareQuery(request.query as Record<string, string | undefined>, 'query');
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));

    const context = call(request);
    const [from, to] = await Promise.all([
      store.read(context, contentId, parsed.value.from),
      store.read(context, contentId, parsed.value.to),
    ]);
    if (from === undefined || to === undefined) return reply.code(404).send(notFound(request));

    const diff = diffRevisions(from.body, to.body);
    return reply.send(successEnvelope({ from, to, diff }, request.id, CLIENT_WINDOW.current));
  });

  app.get(REVISION_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const { contentId, revision } = request.params as { contentId: string; revision: string };
    if (!(await admitted(request, reply, contentId))) return reply;
    const number = revisionNumberIn(revision);
    if (number === undefined) return reply.code(404).send(notFound(request));
    const found = await store.read(call(request), contentId, number);
    if (found === undefined) return reply.code(404).send(notFound(request));
    return reply.send(successEnvelope(found, request.id, CLIENT_WINDOW.current));
  });

  app.post(REVISION_RESTORE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const { contentId, revision } = request.params as { contentId: string; revision: string };
    if (!(await admitted(request, reply, contentId))) return reply;
    const number = revisionNumberIn(revision);
    if (number === undefined) return reply.code(404).send(notFound(request));

    const context = call(request);
    const target = await store.read(context, contentId, number);
    if (target === undefined) return reply.code(404).send(notFound(request));

    const outcome = await store.restore(context, { contentId, revision: number });
    await note(request, context.actor, contentId, number);
    return reply.send(successEnvelope(outcome, request.id, CLIENT_WINDOW.current));
  });
}
