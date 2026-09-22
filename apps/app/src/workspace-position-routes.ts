import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { parseWorkspacePosition, type WorkspacePosition } from '@holydeck/contracts/workspace';

import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { libraryContext } from './library.js';
import { SERVICES_MANAGE } from './roles.js';
import { serviceContext } from './services.js';

import type { RouteNeed } from './authorization.js';
import type { ServiceRecord, ServiceStore } from './services.js';
import type { WorkspacePositionStore } from './workspace-positions.js';
import type { FastifyInstance } from 'fastify';

export const WORKSPACE_POSITION_PATH = '/api/v1/me/workspace-position';

const SESSION: RouteNeed = { kind: 'session' };
const FIELDS = ['serviceId', 'itemId', 'slideId', 'contentId'] as const;

export interface WorkspacePositionRoutesOptions {
  readonly workspacePositions: WorkspacePositionStore | undefined;
  readonly services: ServiceStore | undefined;
  readonly contentExists?: (context: unknown, id: string) => Promise<boolean>;
}

/** Registers the session-scoped workspace position routes. */
export function serveWorkspacePositionRoutes(
  app: FastifyInstance,
  { workspacePositions, services, contentExists }: WorkspacePositionRoutesOptions,
): void {
  if (workspacePositions === undefined) {
    app.get(WORKSPACE_POSITION_PATH, { config: { need: SESSION } }, (request, reply) => reply.code(404).send(notFound(request)));
    app.put(WORKSPACE_POSITION_PATH, { config: { need: SESSION } }, (request, reply) => reply.code(404).send(notFound(request)));
    return;
  }

  app.put(WORKSPACE_POSITION_PATH, { config: { need: SESSION } }, async (request, reply) => {
    const parsed = parseWorkspacePosition(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    await workspacePositions.write(provenSession(request).record.actor, parsed.value);
    return successEnvelope({ position: parsed.value }, request.id, CLIENT_WINDOW.current);
  });

  app.get(WORKSPACE_POSITION_PATH, { config: { need: SESSION } }, async (request) => {
    const guarded = provenSession(request);
    const actor = guarded.record.actor;
    const stored = await workspacePositions.read(actor);
    const original: WorkspacePosition = stored ?? {};
    const keep = { serviceId: true, itemId: true, slideId: true, contentId: true };

    let serviceRecord: ServiceRecord | undefined;
    if (original.serviceId !== undefined) {
      const hasManage = guarded.record.permissions.includes(SERVICES_MANAGE);
      serviceRecord = hasManage && services !== undefined
        ? await services.current(serviceContext(actor, correlationFor('workspace-position:', request.id)), original.serviceId)
        : undefined;
      if (serviceRecord === undefined) keep.serviceId = false;
    }
    if (!keep.serviceId) {
      keep.itemId = false;
    } else if (original.itemId !== undefined) {
      const found = serviceRecord!.sections.some((section) => section.items.some((item) => item.id === original.itemId));
      if (!found) keep.itemId = false;
    }
    if (original.contentId !== undefined) {
      const exists = contentExists !== undefined
        && await contentExists(libraryContext(actor, correlationFor('workspace-position:', request.id)), original.contentId);
      if (!exists) keep.contentId = false;
    }
    if (original.slideId !== undefined) {
      const parentItemOk = original.itemId !== undefined && keep.itemId;
      const parentContentOk = original.contentId !== undefined && keep.contentId;
      if (!parentItemOk && !parentContentOk) keep.slideId = false;
    }

    const dropped: string[] = [];
    const position: Record<string, string> = {};
    for (const field of FIELDS) {
      if (original[field] === undefined) continue;
      if (keep[field]) position[field] = original[field];
      else dropped.push(field);
    }
    const envelope = successEnvelope({ position }, request.id, CLIENT_WINDOW.current);
    return { ...envelope, meta: { ...envelope.meta, dropped } };
  });
}
