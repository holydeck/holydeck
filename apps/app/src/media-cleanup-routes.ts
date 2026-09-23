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
// pass, so "reviewed" here means "the admin read the GET report first", not "the admin picked ids".
//
// `referencedBy` below is a real scan, not a stub: `slide-groups.ts`'s `slideGroupMediaReferences`
// walks every slide group and reusable slide's current body for the media it names (its background,
// its audio track, and each slide's own background override — the same fields `mediaReferencesIn`
// collects) and this module turns that into the synchronous lookup `MediaPurgeOptions.referencedBy`
// needs. It covers exactly the content kinds that reference media through a body shape today; a
// song, reading, or sermon's own reference fields, once those schemas exist (SONG-01 and the sermon
// pipeline), are that task's to add here — the same way `retention-sweep-handler.ts` still separately
// defers grading `autosave-revision` against its own not-yet-built content model. This is the
// list/action/result shape OPS-12's Backups admin page already established, reused here by pattern
// rather than by any shared code (OPS-12's UI is deferred).

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { successEnvelope } from '@holydeck/contracts/http';

import { auditContext } from './audit.js';
import { correlationFor, requestContext } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { MEDIA_ASSET_PERMISSIONS } from './media.js';
import { MEDIA_MANAGE } from './roles.js';
import { slideGroupContext, slideGroupMediaReferences } from './slide-groups.js';

import type { AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { RequestContext } from './context.js';
import type { Identity } from './onboarding.js';
import type { MediaLibrary, MediaPurgeItem } from './media.js';
import type { RepositoryDb } from './repositories.js';
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
  /** The same content database `slideGroupMediaReferences` scans for live references (see the file
   *  header). Absent only where `media` also is — every deployment that has media to purge has this
   *  too, per `main.ts`'s wiring; kept independently optional so a caller can still fail closed to
   *  "nothing is referenced" rather than crash if that ever stops being true. */
  readonly db: RepositoryDb | undefined;
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

/**
 * A fresh `referencedBy` for one request: scans every slide group and reusable slide's current body
 * (`slideGroupMediaReferences`) and turns the resulting map into the synchronous lookup
 * `MediaPurgeOptions.referencedBy` needs. Read live on every call, matching the file header's own
 * "GET and POST both read the same live state at the moment each is called" — never cached across
 * requests, or a purge could act on a reference an edit just added or just dropped. `db === undefined`
 * degrades to "nothing is referenced" rather than throwing, the same fail-open-to-404 posture the rest
 * of this file already takes when a deployment is missing a dependency it needs.
 */
async function referencedByFor(
  db: RepositoryDb | undefined,
  now: () => string,
  actor: string,
  correlationId: string,
): Promise<(assetId: string) => readonly string[]> {
  if (db === undefined) return () => [];
  // Its own context, not the route's `routeContext` above: scanning slide group and reusable slide
  // bodies needs the library and revision permissions `slideGroupContext` grants, not `MEDIA_ASSET_PERMISSIONS`.
  const references = await slideGroupMediaReferences(db, { now }, slideGroupContext(actor, correlationId));
  return (assetId) => references.get(assetId) ?? [];
}

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
  { media, db, now, graceDays, identity }: MediaCleanupRoutesOptions,
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
    const correlationId = correlationFor(MEDIA_CLEANUP_PREFIX, request.id);
    const context = routeContext(actor, correlationId);
    const referencedBy = await referencedByFor(db, now, actor, correlationId);
    const { items } = await media.purgeReport(context, { graceDays, referencedBy });
    return reply.send(successEnvelope(reportFrom(items, now()), request.id, CLIENT_WINDOW.current));
  });

  app.post(MEDIA_CLEANUP_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const actor = provenSession(request).record.actor;
    const correlationId = correlationFor(MEDIA_CLEANUP_PREFIX, request.id);
    const context = routeContext(actor, correlationId);
    const referencedBy = await referencedByFor(db, now, actor, correlationId);
    const outcome = await media.purgeArchived(context, { graceDays, referencedBy });
    await note(request, actor, `purged ${outcome.purged.length}, retained ${outcome.retained.length}`, 'allowed');
    return reply.send(successEnvelope(
      { purged: outcome.purged, purgedCount: outcome.purged.length, retained: outcome.retained },
      request.id,
      CLIENT_WINDOW.current,
    ));
  });
}
