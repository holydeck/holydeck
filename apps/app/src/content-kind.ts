// Which surface a piece of content belongs to, asked of an id alone. `revisions.ts`, the conflict shelf
// and presence all key by content id and nothing else, so a route over any of them has to ask this before
// it answers anything about the id: a Slide Layout's history, conflicts or editors are as much Admin's as
// the Layout is, and holding history, shelf or presence reach alone opens nothing the session could not
// already edit (spec v1c-09, "a `contentKindOf(contentId)` resolver ensures the actor may read that kind").

import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { provenSession, refuseAsForbidden } from './csrf.js';
import { CONTENT_EDIT, LAYOUTS_MANAGE, SERVICE_TEMPLATES_MANAGE } from './roles.js';
import { serviceTemplateContext } from './service-templates.js';
import { slideLayoutContext } from './slide-layouts.js';

import type { Identity } from './onboarding.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Which surface a content id belongs to — and so which permission it is administered under. */
export type RevisedKind = 'slideLayout' | 'serviceTemplate' | 'content';

/** The permission each kind already asks of its own routes; anything keyed by that id asks exactly the same. */
export const KIND_PERMISSION: Readonly<Record<RevisedKind, string>> = Object.freeze({
  slideLayout: LAYOUTS_MANAGE,
  serviceTemplate: SERVICE_TEMPLATES_MANAGE,
  content: CONTENT_EDIT,
});

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

/** Reads every id as ordinary content: what a route falls back to when nothing wired a resolver. */
export const ORDINARY_CONTENT: ContentKindOf = () => Promise.resolve('content');

export interface ContentKindGateOptions {
  /** Where a refusal is recorded. Without one, the refusal still happens; nothing notes it happened. */
  readonly identity: Identity | undefined;
  readonly kindOf: ContentKindOf | undefined;
  readonly prefix: string;
  /** What the refusal says the session reached for: "history", "conflicts", "presence". */
  readonly what: string;
}

/**
 * Whether the session may reach this id at all, answered and recorded as the guard's own refusal when it
 * may not: the same 403, the same `authorization.refuse` entry, one layer further in. A `false` means the
 * reply has already been sent.
 */
export function contentKindGate({ identity, kindOf = ORDINARY_CONTENT, prefix, what }: ContentKindGateOptions) {
  return async (request: FastifyRequest, reply: FastifyReply, contentId: string): Promise<boolean> => {
    const { actor, permissions } = provenSession(request).record;
    const need = KIND_PERMISSION[await kindOf(contentId, actor, correlationFor(prefix, request.id))];
    if (permissions.includes(need)) return true;
    const detail = `this content's ${what} needs ${need}`;
    if (identity !== undefined) {
      try {
        await identity.audit.record(auditContext(actor, correlationFor(prefix, request.id)), {
          action: 'authorization.refuse',
          subject: `${request.method} ${String(request.routeOptions.url)}`,
          outcome: 'refused',
          detail,
        });
      } catch (error: unknown) {
        request.log.error({ err: error }, 'the content-kind trail refused an entry');
      }
    }
    await refuseAsForbidden(request, reply, 'permission', detail);
    return false;
  };
}
