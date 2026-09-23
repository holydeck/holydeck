// Reading the administrative trail `audit.ts` writes (spec v1c-09, ADMN-03/ADMN-04). One route: a page of
// entries, newest first, narrowed by whatever the query names and redacted the way `AUDIT_DETAIL_REDACTION`
// says its action is. Nothing here ever writes — viewing the trail is never itself audited, the same as
// any other GET, `audit.ts`'s own `settings.update` precedent already establishes.

import { FIELD_CODES } from '@holydeck/contracts/problems';
import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { parseAuditQuery } from '@holydeck/contracts/audit';

import { AUDIT_ACTIONS, AUDIT_CATEGORIES, auditReadContext } from './audit.js';
import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { AUDIT_READ } from './roles.js';

import type { AuditAction, AuditCategory } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { Identity } from './onboarding.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const AUDIT_PREFIX = 'audit:';

export const AUDIT_PATH = '/api/v1/audit';

const PERMISSION: RouteNeed = { kind: 'permission', need: AUDIT_READ };

const ROUTES = [['GET', AUDIT_PATH]] as const;

function isCategory(value: string): value is AuditCategory {
  return (AUDIT_CATEGORIES as readonly string[]).includes(value);
}

function isAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}

export interface AuditRoutesOptions {
  readonly identity: Identity | undefined;
}

export function serveAuditRoutes(app: FastifyInstance, { identity }: AuditRoutesOptions): void {
  if (identity === undefined) {
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

  const trail = identity.audit;

  app.get(AUDIT_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseAuditQuery(request.query as Record<string, string | undefined>, 'query');
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));

    const { category, action, cursorAt, cursorId, ...rest } = parsed.value;
    if (category !== undefined && !isCategory(category)) {
      return reply.code(422).send(
        validationFailure(request.id, [{ path: 'query.category', code: FIELD_CODES.notAllowed, message: 'not a recognized category' }]),
      );
    }
    if (action !== undefined && !isAction(action)) {
      return reply.code(422).send(
        validationFailure(request.id, [{ path: 'query.action', code: FIELD_CODES.notAllowed, message: 'not a recognized action' }]),
      );
    }

    const context = auditReadContext(provenSession(request).record.actor, correlationFor(AUDIT_PREFIX, request.id));
    const page = await trail.list(context, {
      ...rest,
      ...(category !== undefined ? { category } : {}),
      ...(action !== undefined ? { action } : {}),
      ...(cursorAt !== undefined && cursorId !== undefined ? { cursor: { at: cursorAt, id: cursorId } } : {}),
    });
    return reply.send(successEnvelope(page, request.id, CLIENT_WINDOW.current));
  });
}
