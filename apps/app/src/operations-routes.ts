// Where an operator sees this deployment's operational health at a glance (OPS-09). Shaped like
// `job-routes.ts`: one permission, `OPERATIONS_READ`, gates the route, and a deployment missing any of
// the sources the report needs serves the same path answering not-found — there is no partial report to
// return when a required source cannot be built at all.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { successEnvelope } from '@holydeck/contracts/http';

import { BACKUP_RECORD } from './backups.js';
import { correlationFor, requestContext } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { MEDIA_ASSET_PERMISSIONS } from './media.js';
import { observeOperationalHealth } from './operational-health.js';
import { operationalSourcesOn } from './operational-sources.js';
import { QUEUE_PERMISSIONS } from './queue.js';
import { permissionsFor } from './records.js';
import { RESTORE_RECORD } from './restores.js';
import { OPERATIONS_READ } from './roles.js';

import type { RouteNeed } from './authorization.js';
import type { RequestContext } from './context.js';
import type { MediaLibrary } from './media.js';
import type { Identity } from './onboarding.js';
import type { Queue } from './queue.js';
import type { RepositoryDb } from './repositories.js';
import type { FastifyInstance } from 'fastify';

const OPERATIONS_PREFIX = 'operations:';

export const OPERATIONS_HEALTH_PATH = '/api/v1/operations/health';

const PERMISSION: RouteNeed = { kind: 'permission', need: OPERATIONS_READ };

export interface OperationsRoutesOptions {
  /** Absent whenever `identity` is, per `main.ts`'s wiring — never independently, from this module's view. */
  readonly db: RepositoryDb | undefined;
  readonly queue: Queue | undefined;
  readonly media: MediaLibrary | undefined;
  readonly dataDir: string;
  /** Injected the same way `backup-routes.ts`/`restore-routes.ts` inject theirs — one clock, one caller. */
  readonly now: () => string;
  readonly identity: Identity | undefined;
}

/** What this route needs to read every source `operational-sources.ts` builds, and nothing to write. */
function routeContext(actor: string, correlationId: string): RequestContext {
  return requestContext({
    actor,
    permissions: [
      QUEUE_PERMISSIONS.read,
      permissionsFor(BACKUP_RECORD).read,
      permissionsFor(RESTORE_RECORD).read,
      MEDIA_ASSET_PERMISSIONS.read,
    ],
    correlationId,
  });
}

export function serveOperationsRoutes(
  app: FastifyInstance,
  { db, queue, media, dataDir, now, identity }: OperationsRoutesOptions,
): void {
  // A deployment missing any required source has nothing complete here to report — the worker heartbeat
  // is read straight off `dataDir`, always present, so the other three are what gate this.
  if (identity === undefined || db === undefined || queue === undefined || media === undefined) {
    app.get(OPERATIONS_HEALTH_PATH, { config: { need: PERMISSION } }, (request, reply) =>
      reply.code(404).send(notFound(request)),
    );
    return;
  }

  app.get(OPERATIONS_HEALTH_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const actor = provenSession(request).record.actor;
    const context = routeContext(actor, correlationFor(OPERATIONS_PREFIX, request.id));
    const sources = operationalSourcesOn({ db, queue, media, dataDir, now }, context);
    const health = await observeOperationalHealth(sources);
    return reply.send(successEnvelope({ health }, request.id, CLIENT_WINDOW.current));
  });
}
