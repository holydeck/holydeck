import { accountIdIn } from '@holydeck/contracts/accounts';
import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { parseNotificationPreferences } from '@holydeck/contracts/notifications';

import { AUDIT_ACTIONS, CATEGORY_OF, auditContext, auditReadContext } from './audit.js';
import { correlationFor } from './context.js';
import { notFound } from './failures.js';
import { provenSession, refuseAsForbidden } from './csrf.js';
import { deriveNotifications } from './notifications.js';
import { NOTIFICATIONS_USE, OPERATIONS_READ } from './roles.js';

import type { AuditAction, AuditCategory, AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { Identity } from './onboarding.js';
import type { NotifiableEventReader } from './notifications.js';
import type { NotificationStore } from './notification-store.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const NOTIFICATIONS_PREFIX = 'notifications:';

const NOT_AN_ACCOUNT = 'a notification belongs to an account, and this session is not held by one';

export const NOTIFICATIONS_PATH = '/api/v1/notifications';
export const NOTIFICATIONS_READ_ALL_PATH = `${NOTIFICATIONS_PATH}/read-all`;
export const NOTIFICATIONS_PREFERENCES_PATH = `${NOTIFICATIONS_PATH}/preferences`;

const PERMISSION: RouteNeed = { kind: 'permission', need: NOTIFICATIONS_USE };

// The two categories every signed-in account may hear about regardless of role: what changed in the
// content and what ran on stage. Every other category names something an operator did to the deployment
// itself, which `NOTIFICATIONS_USE`'s blanket grant (every account, every role) was never meant to expose
// — only `OPERATIONS_READ` (admin alone) reaches the unrestricted trail.
const OPEN_CATEGORIES: readonly AuditCategory[] = ['content', 'presentation'];
const OPEN_ACTIONS: readonly AuditAction[] = AUDIT_ACTIONS.filter((action) => OPEN_CATEGORIES.includes(CATEGORY_OF[action]));

/** `undefined` reads the whole trail; a narrower list restricts a caller without `OPERATIONS_READ` to it. */
const actionsAllowedFor = (permissions: readonly string[]): readonly AuditAction[] | undefined =>
  permissions.includes(OPERATIONS_READ) ? undefined : OPEN_ACTIONS;

const ROUTES = [
  ['GET', NOTIFICATIONS_PATH],
  ['POST', `${NOTIFICATIONS_PATH}/:id/read`],
  ['POST', NOTIFICATIONS_READ_ALL_PATH],
  ['POST', `${NOTIFICATIONS_PATH}/:id/dismiss`],
  ['GET', NOTIFICATIONS_PREFERENCES_PATH],
  ['PUT', NOTIFICATIONS_PREFERENCES_PATH],
] as const;

export interface NotificationRoutesOptions {
  readonly store: NotificationStore | undefined;
  readonly events: NotifiableEventReader | undefined;
  readonly identity: Identity | undefined;
}

export function serveNotificationRoutes(
  app: FastifyInstance,
  { store, events, identity }: NotificationRoutesOptions,
): void {
  if (identity === undefined || store === undefined || events === undefined) {
    for (const [method, url] of ROUTES) {
      app.route({ method, url, config: { need: PERMISSION }, handler: (request, reply) => reply.code(404).send(notFound(request)) });
    }
    return;
  }

  const note = async (
    request: FastifyRequest,
    actor: string,
    action: AuditAction,
    subject: string,
    outcome: AuditOutcome,
  ): Promise<void> => {
    try {
      await identity.audit.record(auditContext(actor, correlationFor(NOTIFICATIONS_PREFIX, request.id)), {
        action,
        subject,
        outcome,
      });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the notifications trail refused an entry');
    }
  };

  const asker = async (request: FastifyRequest, reply: FastifyReply): Promise<string | undefined> => {
    const id = accountIdIn(provenSession(request).record.actor);
    if (id === undefined) await refuseAsForbidden(request, reply, 'actor', NOT_AN_ACCOUNT);
    return id;
  };

  app.get(NOTIFICATIONS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const accountId = await asker(request, reply);
    if (accountId === undefined) return reply;
    const watermark = await store.watermarkFor(accountId);
    const preference = await store.preferencesFor(accountId);
    const session = provenSession(request);
    const actor = session.record.actor;
    const context = auditReadContext(actor, correlationFor(NOTIFICATIONS_PREFIX, request.id));
    const derivation = await deriveNotifications(events, context, [{ ...preference, recipient: actor }], {
      since: watermark,
      actions: actionsAllowedFor(session.record.permissions),
    });
    await store.materialize(derivation.notifications.map((notification) => ({ ...notification, recipient: accountId })));
    if (derivation.watermark !== undefined) await store.setWatermark(accountId, derivation.watermark);
    const unread = (request.query as { readonly unread?: string }).unread === 'true';
    const rows = await store.listFor(accountId, { unread });
    return successEnvelope({ notifications: rows }, request.id, CLIENT_WINDOW.current);
  });

  app.post(`${NOTIFICATIONS_PATH}/:id/read`, { config: { need: PERMISSION } }, async (request, reply) => {
    const accountId = await asker(request, reply);
    if (accountId === undefined) return reply;
    const id = (request.params as { readonly id: string }).id;
    const changed = await store.markRead(accountId, id);
    if (!changed) return reply.code(404).send(notFound(request));
    await note(request, provenSession(request).record.actor, 'notification.read', id, 'allowed');
    return reply.send(successEnvelope({ read: true }, request.id, CLIENT_WINDOW.current));
  });

  app.post(NOTIFICATIONS_READ_ALL_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const accountId = await asker(request, reply);
    if (accountId === undefined) return reply;
    await store.markAllRead(accountId);
    await note(request, provenSession(request).record.actor, 'notification.read', 'all', 'allowed');
    return reply.send(successEnvelope({ read: true }, request.id, CLIENT_WINDOW.current));
  });

  app.post(`${NOTIFICATIONS_PATH}/:id/dismiss`, { config: { need: PERMISSION } }, async (request, reply) => {
    const accountId = await asker(request, reply);
    if (accountId === undefined) return reply;
    const id = (request.params as { readonly id: string }).id;
    const changed = await store.markDismissed(accountId, id);
    if (!changed) return reply.code(404).send(notFound(request));
    await note(request, provenSession(request).record.actor, 'notification.dismiss', id, 'allowed');
    return reply.send(successEnvelope({ dismissed: true }, request.id, CLIENT_WINDOW.current));
  });

  app.get(NOTIFICATIONS_PREFERENCES_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const accountId = await asker(request, reply);
    if (accountId === undefined) return reply;
    const preference = await store.preferencesFor(accountId);
    return successEnvelope({ preferences: preference }, request.id, CLIENT_WINDOW.current);
  });

  app.put(NOTIFICATIONS_PREFERENCES_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const accountId = await asker(request, reply);
    if (accountId === undefined) return reply;
    const parsed = parseNotificationPreferences(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    await store.setPreferences(accountId, { recipient: accountId, ...parsed.value });
    await note(request, provenSession(request).record.actor, 'notification.preferences', accountId, 'allowed');
    return reply.send(successEnvelope({ saved: true }, request.id, CLIENT_WINDOW.current));
  });
}
