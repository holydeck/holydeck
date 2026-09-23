import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { buildApp } from './app.js';
import { loadSettings } from './settings.js';
import { accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditContext, auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { FORBIDDEN, guardMutations } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { NOTIFICATIONS_USE, permissionsFor } from './roles.js';
import { NOTIFICATIONS_PATH, NOTIFICATIONS_PREFERENCES_PATH, serveNotificationRoutes } from './notification-routes.js';
import { notificationStoreOn } from './notification-store.js';
import { repositoriesOn } from './repositories.js';
import { fakeNotificationDb } from '../test/helpers/fake-notification-db.js';
import { passkeysOn } from './passkeys.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { Identity } from './onboarding.js';
import type { NotificationStore } from './notification-store.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance } from 'fastify';

const NOW = '2026-09-21T23:30:00.000Z';
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const CORRELATION = 'req-0f9c2a41';
const ADMINISTRATOR = 'account:' + 'C'.repeat(22);
const now = (): string => instant;

let app: FastifyInstance;
let sessions: SessionStore;
let trail: FakeDb;
let identity: Identity;
let store: NotificationStore;
let instant: string;
let eventNumber: number;
let admin: StartedSession;

const withHeaders = (held: StartedSession = admin) => ({
  [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
  host: HOST,
  'x-forwarded-proto': 'https',
  origin: ORIGIN,
  cookie: sessionCookie(held.token, 60),
  [CSRF_HEADER]: held.record.csrf,
});

const served = async (missing?: 'store' | 'events' | 'identity' | 'all'): Promise<FastifyInstance> => {
  const built = Fastify({ logger: false });
  withSafeErrors(built);
  guardMutations(built, { sessions });
  enforceAuthorization(built, { sessions, identity: undefined });
  serveNotificationRoutes(built, {
    store: missing === 'store' || missing === 'all' ? undefined : store,
    events: missing === 'events' || missing === 'all' ? undefined : repositoriesOn(trail).auditEvents,
    identity: missing === 'identity' || missing === 'all' ? undefined : identity,
  });
  await built.ready();
  return built;
};

beforeEach(async () => {
  instant = NOW;
  eventNumber = 0;
  trail = fakeDb();
  store = notificationStoreOn(fakeNotificationDb(), { now });
  sessions = sessionsOn(memorySessions().db, { now });
  identity = {
    accounts: accountsOn(memoryAccounts().db, {
      now,
      newId: () => 'A'.repeat(22),
      hash: async (password) => `test-hash:${password}`,
      verify: async (password, stored) => stored === `test-hash:${password}`,
    }),
    audit: auditOn(trail, { now, newId: () => `e${++eventNumber}` }),
    attempts: attemptsOn(memoryAttempts().db, { now }),
    totp: totpsOn(memoryTotp().db, { now }),
    passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
  app = await served();
  admin = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: permissionsFor({
    id: 'C'.repeat(22), name: 'member', displayName: 'Member', role: 'member', createdAt: NOW,
    controlPresentation: false, disabled: false,
  }) });
});

afterEach(async () => {
  await app.close();
});

const accountId = 'C'.repeat(22);
const foreignId = 'D'.repeat(22);
const entry = async (actor = 'system') => {
  await identity.audit.record(auditContext(actor, CORRELATION), {
    action: 'content.change', subject: 'song:1', outcome: 'allowed',
  });
};
const getInbox = (query = '') => app.inject({ method: 'GET', url: NOTIFICATIONS_PATH + query, headers: withHeaders() });
const mutate = (path: string) => app.inject({ method: 'POST', url: `${NOTIFICATIONS_PATH}/${path}`, headers: withHeaders() });
const notificationId = `audit:e1:${accountId}:inApp`;

describe('an account notification inbox', () => {
  test('serves a persisted inbox through the complete application wiring', async () => {
    const notificationDb = fakeNotificationDb();
    await auditOn(notificationDb, { now, newId: () => 'wired' }).record(auditContext('system', CORRELATION), {
      action: 'content.change', subject: 'song:1', outcome: 'allowed',
    });
    await app.close();
    app = buildApp({
      settings: loadSettings({ env: {} }), logger: false,
      fetching: async () => { throw new Error('not used'); }, sessions, identity, notificationDb,
    });
    const response = await getInbox();
    expect(response.statusCode).toBe(200);
    expect(response.json().data.notifications).toMatchObject([{ event: 'audit:wired', accountId }]);
  });

  test('derives, persists and lists the first page using the real audit repository', async () => {
    await entry();
    const response = await getInbox();
    expect(response.statusCode).toBe(200);
    expect(response.json().data.notifications).toMatchObject([{
      _id: notificationId, accountId, event: 'audit:e1', action: 'content.change', createdAt: NOW,
    }]);
    expect(await store.watermarkFor(accountId)).toBe(NOW);
    expect(await store.listFor(accountId)).toHaveLength(1);
  });

  test('keeps read and dismissed state while materializing a later event', async () => {
    await entry();
    await getInbox();
    expect((await mutate(`${notificationId}/read`)).statusCode).toBe(200);
    expect((await mutate(`${notificationId}/dismiss`)).statusCode).toBe(200);
    instant = '2026-09-21T23:31:00.000Z';
    await entry();
    const response = await getInbox();
    expect(response.statusCode).toBe(200);
    expect(response.json().data.notifications).toMatchObject([
      { event: 'audit:e4', createdAt: instant }, { event: 'audit:e1', readAt: NOW, dismissedAt: NOW },
    ]);
    expect((await getInbox('?unread=true')).json().data.notifications).toMatchObject([{ event: 'audit:e4' }]);
  });

  test('excludes own actions by default and includes them when requested', async () => {
    await entry(ADMINISTRATOR);
    expect((await getInbox()).json().data.notifications).toEqual([]);
    await store.setPreferences(accountId, { ...(await store.preferencesFor(accountId)), ownActions: true });
    instant = '2026-09-21T23:31:00.000Z';
    await entry(ADMINISTRATOR);
    expect((await getInbox()).json().data.notifications).toMatchObject([{ event: 'audit:e2', accountId }]);
  });

  test('never surfaces a restricted-category event to a caller without operations.read', async () => {
    await identity.audit.record(auditContext('system', CORRELATION), {
      action: 'session.signIn', subject: accountId, outcome: 'allowed',
    });
    await entry();
    const response = await getInbox();
    expect(response.statusCode).toBe(200);
    expect(response.json().data.notifications).toMatchObject([{ action: 'content.change' }]);
  });

  test('surfaces every category to a caller with operations.read', async () => {
    const operator = await sessions.start(sessionContext(CORRELATION), {
      actor: 'account:' + 'E'.repeat(22),
      permissions: [...permissionsFor({
        id: 'E'.repeat(22), name: 'admin', displayName: 'Admin', role: 'admin', createdAt: NOW,
        controlPresentation: false, disabled: false,
      })],
    });
    await identity.audit.record(auditContext('system', CORRELATION), {
      action: 'session.signIn', subject: 'account:' + 'E'.repeat(22), outcome: 'allowed',
    });
    const response = await app.inject({ method: 'GET', url: NOTIFICATIONS_PATH, headers: withHeaders(operator) });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.notifications).toMatchObject([{ action: 'session.signIn' }]);
  });

  test('returns an empty inbox without creating a watermark when no events exist', async () => {
    expect((await getInbox()).json().data.notifications).toEqual([]);
    expect(await store.watermarkFor(accountId)).toBeUndefined();
  });

  test('lets a member reach every route and limits mutations to their own rows', async () => {
    expect(admin.record.permissions).toContain(NOTIFICATIONS_USE);
    await entry();
    await getInbox();
    const [own] = await store.listFor(accountId);
    await store.materialize([{
      sourceEventId: 'foreign-event', recipient: foreignId, at: NOW, channel: 'inApp', category: 'content',
      action: 'content.change', subject: 'song:1', outcome: 'allowed', severity: 'notice', correlationId: CORRELATION,
    }]);
    for (const action of ['read', 'dismiss']) {
      expect((await mutate(`foreign-event:${foreignId}:inApp/${action}`)).statusCode).toBe(404);
      expect((await mutate(`missing/${action}`)).statusCode).toBe(404);
      expect((await mutate(`${own?._id}/${action}`)).statusCode).toBe(200);
    }
    expect((await mutate('read-all')).statusCode).toBe(200);
    expect(await store.listFor(accountId, { unread: true })).toEqual([]);
    expect((await store.listFor(foreignId))[0]?.readAt).toBeUndefined();
    expect((await store.listFor(foreignId))[0]?.dismissedAt).toBeUndefined();
    const preference = { muted: true, ownActions: true, channels: [] };
    const put = await app.inject({ method: 'PUT', url: NOTIFICATIONS_PREFERENCES_PATH, headers: withHeaders(), payload: preference });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: NOTIFICATIONS_PREFERENCES_PATH, headers: withHeaders() });
    expect(get.statusCode).toBe(200);
    expect(get.json().data.preferences).toMatchObject({ recipient: accountId, ...preference });
    expect((await store.preferencesFor(foreignId)).muted).toBe(false);
    expect(trail.rows.get('audit_events')?.map((event) => event['action'])).toEqual([
      'content.change', 'notification.read', 'notification.dismiss', 'notification.read', 'notification.preferences',
    ]);
  });

  test('rejects invalid preferences without saving or auditing a change', async () => {
    const response = await app.inject({ method: 'PUT', url: NOTIFICATIONS_PREFERENCES_PATH, headers: withHeaders(), payload: { muted: false, channels: [{ channel: 'sms' }] } });
    expect(response.statusCode).toBe(422);
    expect((await store.preferencesFor(accountId)).muted).toBe(false);
    expect(trail.rows.get('audit_events') ?? []).toEqual([]);
  });

  test('still answers success when a mutation audit write fails', async () => {
    await entry();
    await getInbox();
    trail.failOn = () => new Error('trail unavailable');
    expect((await mutate(`${notificationId}/read`)).statusCode).toBe(200);
    expect((await store.listFor(accountId))[0]?.readAt).toBe(NOW);
  });
});

const routes = [
  ['GET', NOTIFICATIONS_PATH], ['POST', `${NOTIFICATIONS_PATH}/missing/read`],
  ['POST', `${NOTIFICATIONS_PATH}/read-all`], ['POST', `${NOTIFICATIONS_PATH}/missing/dismiss`],
  ['GET', NOTIFICATIONS_PREFERENCES_PATH], ['PUT', NOTIFICATIONS_PREFERENCES_PATH],
] as const;

describe('notification route guards', () => {
  test.each(['store', 'events', 'identity', 'all'] as const)('answers not-found without %s on every route', async (missing) => {
    await app.close();
    app = await served(missing);
    for (const [method, url] of routes) {
      expect((await app.inject({ method, url, headers: withHeaders() })).statusCode).toBe(404);
    }
  });

  test('refuses a session without notifications.use on every route', async () => {
    const held = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [] });
    for (const [method, url] of routes) {
      const response = await app.inject({ method, url, headers: withHeaders(held) });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe(FORBIDDEN);
    }
  });

  test('refuses a non-account actor even if the session carries the permission', async () => {
    const held = await sessions.start(sessionContext(CORRELATION), { actor: 'guest:invited', permissions: [NOTIFICATIONS_USE] });
    for (const [method, url] of routes) {
      expect((await app.inject({ method, url, headers: withHeaders(held) })).statusCode).toBe(403);
    }
  });
});
