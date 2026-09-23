import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { FORBIDDEN, guardMutations, mutatingRoutesOf } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { INTEGRATIONS_PATH, INTEGRATION_ID_PATH, serveIntegrationRoutes } from './integration-routes.js';
import { passkeysOn } from './passkeys.js';
import { INTEGRATIONS_MANAGE } from './roles.js';
import { settingsAdminOn } from './settings-admin.js';
import { CANONICAL_SETTINGS_PATH, loadSettings } from './settings.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { fakeSettingsIO } from '../test/helpers/settings-io.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { Identity } from './onboarding.js';
import type { SettingsAdmin } from './settings-admin.js';
import type { Document } from './repositories.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance } from 'fastify';

const NOW = '2026-09-13T09:30:00.000Z';
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const CORRELATION = 'req-0f9c2a41';
const ADMINISTRATOR = 'account:' + 'C'.repeat(22);
const KEY = 'k'.repeat(24);
const PATH = CANONICAL_SETTINGS_PATH;

const seed = (fileText: string) => loadSettings({ fileText, env: {}, path: PATH });

let app: FastifyInstance;
let sessions: SessionStore;
let trail: FakeDb;
let identity: Identity;
let settingsAdmin: SettingsAdmin;
let admin: StartedSession;

const now = (): string => NOW;

const entries = (): Document[] => trail.rows.get('audit_events') ?? [];

const withHeaders = (held: StartedSession = admin) => ({
  [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
  host: HOST,
  'x-forwarded-proto': 'https',
  origin: ORIGIN,
  cookie: sessionCookie(held.token, 60),
  [CSRF_HEADER]: held.record.csrf,
});

const reading = (held: StartedSession = admin) =>
  app.inject({ method: 'GET', url: INTEGRATIONS_PATH, headers: withHeaders(held) });

const patching = (id: string, payload: unknown, held: StartedSession = admin) =>
  app.inject({ method: 'PATCH', url: `${INTEGRATIONS_PATH}/${id}`, headers: withHeaders(held), payload: payload as never });

const build = (fileText: string) => {
  const io = fakeSettingsIO({ [PATH]: fileText });
  settingsAdmin = settingsAdminOn(seed(fileText), { ...io, env: {} });
  app = Fastify({ logger: false });
  withSafeErrors(app);
  guardMutations(app, { sessions });
  enforceAuthorization(app, { sessions, identity: undefined });
  serveIntegrationRoutes(app, { settingsAdmin, identity });
};

beforeEach(async () => {
  trail = fakeDb();
  sessions = sessionsOn(memorySessions().db, { now });
  const accounts = accountsOn(memoryAccounts().db, {
    now,
    newId: () => 'A'.repeat(22),
    hash: async (password) => `test-hash:${password}`,
    verify: async (password, stored) => stored === `test-hash:${password}`,
  });
  identity = {
    accounts,
    audit: auditOn(trail, { now, newId: () => `e${entries().length}` }),
    attempts: attemptsOn(memoryAttempts().db, { now }),
    totp: totpsOn(memoryTotp().db, { now }),
    passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
  build('locale: en\n');
  await app.ready();
  admin = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [INTEGRATIONS_MANAGE] });
});

afterEach(async () => {
  await app.close();
});

describe('reading integration status', () => {
  test('answers unconfigured and disabled when no credential is set', async () => {
    const response = await reading();
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      { id: 'sermon-ai', configured: false, enabled: false, lastCallAt: null, callsInLast30Days: 0 },
    ]);
  });

  test('answers configured and enabled once a credential is set and the switch is on', async () => {
    await app.close();
    build(`locale: en\nanthropicApiKey: ${KEY}\nsermonAiEnabled: true\n`);
    await app.ready();
    const response = await reading();
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      { id: 'sermon-ai', configured: true, enabled: true, lastCallAt: null, callsInLast30Days: 0 },
    ]);
  });
});

describe('toggling an integration', () => {
  test('disables a configured integration and records the toggle', async () => {
    await app.close();
    build(`locale: en\nanthropicApiKey: ${KEY}\nsermonAiEnabled: true\n`);
    await app.ready();

    const response = await patching('sermon-ai', { enabled: false });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.enabled).toBe(false);
    expect(entries()).toEqual([
      expect.objectContaining({ action: 'integration.disable', subject: 'sermon-ai', detail: 'disabled' }),
    ]);
  });

  test('cannot enable it without a configured credential, and the trail says so', async () => {
    const response = await patching('sermon-ai', { enabled: true });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.enabled).toBe(false);
    expect(entries()).toEqual([
      expect.objectContaining({ action: 'integration.disable', subject: 'sermon-ai', detail: 'disabled' }),
    ]);
  });

  test('refuses an integration this deployment does not know', async () => {
    const response = await patching('not-real', { enabled: true });
    expect(response.statusCode).toBe(404);
  });
});

describe('who may ask any of it', () => {
  test('every route here changes something, and so it is behind the guard', () => {
    expect(mutatingRoutesOf(app)).toEqual([{ method: 'PATCH', url: INTEGRATION_ID_PATH }]);
  });

  test('refuses a session without integrations.manage, for both routes', async () => {
    const guest = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [] });
    for (const response of [await reading(guest), await patching('sermon-ai', { enabled: false }, guest)]) {
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe(FORBIDDEN);
    }
  });
});

describe('what this surface refuses to answer at all', () => {
  test('a deployment that keeps neither serves both paths, and answers not-found from each', async () => {
    await app.close();
    app = Fastify({ logger: false });
    withSafeErrors(app);
    guardMutations(app, { sessions });
    enforceAuthorization(app, { sessions, identity: undefined });
    serveIntegrationRoutes(app, { settingsAdmin: undefined, identity: undefined });
    await app.ready();
    expect((await reading()).statusCode).toBe(404);
    expect((await patching('sermon-ai', { enabled: false })).statusCode).toBe(404);
  });

  test('answers not-found from the identity gate alone, even with a settings admin configured', async () => {
    await app.close();
    app = Fastify({ logger: false });
    withSafeErrors(app);
    guardMutations(app, { sessions });
    enforceAuthorization(app, { sessions, identity: undefined });
    serveIntegrationRoutes(app, { settingsAdmin, identity: undefined });
    await app.ready();
    expect((await reading()).statusCode).toBe(404);
    expect((await patching('sermon-ai', { enabled: false })).statusCode).toBe(404);
  });
});
