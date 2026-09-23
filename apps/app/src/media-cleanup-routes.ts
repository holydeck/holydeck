// Where an operator sees what the media library holds that is safe to remove, and performs a
// reviewed purge of it (OPS-15). Shaped like `job-routes.ts`: one permission, `MEDIA_MANAGE`, gates
// both routes, and a deployment with nowhere to keep media serves the same paths answering
// not-found.
//
// The GET report and the POST purge read the same live state at the moment each is called — GET
// through `MediaLibrary.purgeReport`, POST through `MediaLibrary.purgeArchived` — so nothing an
// admin sees in a report can go stale between reading it and asking for the purge it describes; an
// item archived, referenced, or restored between the two calls simply grades differently the second
// time. There is no per-item selection: `purgeArchived` purges every currently-eligible item in one
// pass, so "reviewed" here means "the admin read the GET report first", not "the admin picked ids" —
// the reference-tracking this codebase would need to make individual-item selection meaningful does
// not exist yet (the same gap `retention-sweep-handler.ts` already documents for
// `autosave-revision`). This is the list/action/result shape OPS-12's Backups admin page already
// established, reused here by pattern rather than by any shared code (OPS-12's UI is deferred).

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { successEnvelope } from '@holydeck/contracts/http';

import { auditContext } from './audit.js';
import { correlationFor, requestContext } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { MEDIA_ASSET_PERMISSIONS } from './media.js';
import { MEDIA_MANAGE } from './roles.js';

import type { AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { RequestContext } from './context.js';
import type { Identity } from './onboarding.js';
import type { MediaLibrary, MediaPurgeItem } from './media.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const MEDIA_CLEANUP_PREFIX = 'media-cleanup:';

export const MEDIA_CLEANUP_PATH = '/api/v1/media/cleanup';

const PERMISSION: RouteNeed = { kind: 'permission', need: MEDIA_MANAGE };

const ROUTES = [
  ['GET', MEDIA_CLEANUP_PATH],
  ['POST', MEDIA_CLEANUP_PATH],
] as const;

export interface MediaCleanupRoutesOptions {
  /** Absent whenever `identity` is, per `main.ts`'s wiring — never independently, from this module's view. */
  readonly media: MediaLibrary | undefined;
  /** Fixed clock: the same one the report's `generatedAt` is read from. */
  readonly now: () => string;
  /** `settings.values.mediaArchivedPurgeGraceDays` — read once per request, so a settings change
   *  applies to the next report/purge without a restart. */
  readonly graceDays: number;
  readonly identity: Identity | undefined;
}

function routeContext(actor: string, correlationId: string): RequestContext {
  return requestContext({ actor, permissions: [...Object.values(MEDIA_ASSET_PERMISSIONS)], correlationId });
}

// No content model in this deployment tracks media references yet (see the file header) — every
// item grades as unreferenced until that model exists.
const referencedBy = (): readonly string[] => [];

const reportFrom = (items: readonly MediaPurgeItem[], generatedAt: string) => {
  const totals = { gracePeriod: 0, eligible: 0, protected: 0 };
  for (const item of items) {
    if (item.category === 'grace-period') totals.gracePeriod += 1;
    else if (item.category === 'eligible') totals.eligible += 1;
    else totals.protected += 1;
  }
  const reclaimableBytes = items.filter((item) => item.category === 'eligible').reduce((sum, item) => sum + item.bytes, 0);
  return { generatedAt, items, reclaimableBytes, totals };
};

export function serveMediaCleanupRoutes(
  app: FastifyInstance,
  { media, now, graceDays, identity }: MediaCleanupRoutesOptions,
): void {
  // A deployment with nowhere to keep media has nothing here to report or to purge. Every path is
  // still served, so the guard's table remains the complete shape of the surface in every deployment.
  if (identity === undefined || media === undefined) {
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

  const note = async (request: FastifyRequest, actor: string, subject: string, outcome: AuditOutcome): Promise<void> => {
    try {
      await identity.audit.record(auditContext(actor, correlationFor(MEDIA_CLEANUP_PREFIX, request.id)), {
        action: 'media.cleanup',
        subject,
        outcome,
      });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the media cleanup trail refused an entry');
    }
  };

  app.get(MEDIA_CLEANUP_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const actor = provenSession(request).record.actor;
    const context = routeContext(actor, correlationFor(MEDIA_CLEANUP_PREFIX, request.id));
    const { items } = await media.purgeReport(context, { graceDays, referencedBy });
    return reply.send(successEnvelope(reportFrom(items, now()), request.id, CLIENT_WINDOW.current));
  });

  app.post(MEDIA_CLEANUP_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const actor = provenSession(request).record.actor;
    const context = routeContext(actor, correlationFor(MEDIA_CLEANUP_PREFIX, request.id));
    const outcome = await media.purgeArchived(context, { graceDays, referencedBy });
    await note(request, actor, `purged ${outcome.purged.length}, retained ${outcome.retained.length}`, 'allowed');
    return reply.send(successEnvelope(
      { purged: outcome.purged, purgedCount: outcome.purged.length, retained: outcome.retained },
      request.id,
      CLIENT_WINDOW.current,
    ));
  });
}
