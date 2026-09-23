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
import type { FakeSettingsIO } from '../test/helpers/settings-io.js';
import type { FastifyInstance } from 'fastify';

const NOW = '2026-09-13T09:30:00.000Z';
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const CORRELATION = 'req-0f9c2a41';
const ADMINISTRATOR = 'account:' + 'C'.repeat(22);
const KEY = 'k'.repeat(24);
const PATH = CANONICAL_SETTINGS_PATH;


let app: FastifyInstance;
let sessions: SessionStore;
let trail: FakeDb;
let identity: Identity;
let settingsAdmin: SettingsAdmin;
let settingsIO: FakeSettingsIO;
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

const build = (fileText: string, env: Record<string, string> = {}) => {
  settingsIO = fakeSettingsIO({ [PATH]: fileText });
  settingsAdmin = settingsAdminOn(loadSettings({ fileText, env, path: PATH }), { ...settingsIO, env });
  app = Fastify({ logger: false });
  withSafeErrors(app);
  guardMutations(app, { sessions });
  enforceAuthorization(app, { sessions, identity: undefined });
  serveIntegrationRoutes(app, { settingsAdmin, identity, clock: () => new Date(NOW) });
};

const rebuild = async (fileText: string, env: Record<string, string> = {}) => {
  await app.close();
  build(fileText, env);
  await app.ready();
};

/** A call the sermon resolver made, filed straight into the trail at the instant given. */
const called = (at: string, id: string) =>
  trail.collection('audit_events').insertOne({
    _id: `audit:${id}`, actor: ADMINISTRATOR, correlationId: 'sermon:req', at, action: 'integration.call',
    category: 'integration', subject: 'resolver', outcome: 'allowed', durationMs: 900,
  });

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
      { id: 'sermon-ai', configured: false, enabled: false, lastCallAt: null, callsInLast30Days: 0, lockedByEnvironment: false },
    ]);
  });

  test('answers configured and enabled once a credential is set and the switch is on', async () => {
    await app.close();
    build(`locale: en\nanthropicApiKey: ${KEY}\nsermonAiEnabled: true\n`);
    await app.ready();
    const response = await reading();
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      { id: 'sermon-ai', configured: true, enabled: true, lastCallAt: null, callsInLast30Days: 0, lockedByEnvironment: false },
    ]);
  });

  test('reads the last call and the calls of the last 30 days back out of the trail', async () => {
    await called('2026-07-01T00:00:00.000Z', 'old');
    await called('2026-09-01T08:00:00.000Z', 'one');
    await called('2026-09-12T08:00:00.000Z', 'two');
    const response = await reading();
    expect(response.json().data[0]).toMatchObject({ lastCallAt: '2026-09-12T08:00:00.000Z', callsInLast30Days: 2 });
  });

  test('says when the environment holds the switch, so the page can say why it will not move', async () => {
    await rebuild(`locale: en\nanthropicApiKey: ${KEY}\n`, { HOLYDECK_SERMON_AI_ENABLED: 'true' });
    expect((await reading()).json().data[0]).toMatchObject({ enabled: true, lockedByEnvironment: true });
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

  test('enables a configured integration and records it as the enable it is', async () => {
    await rebuild(`locale: en\nanthropicApiKey: ${KEY}\n`);
    const response = await patching('sermon-ai', { enabled: true });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.enabled).toBe(true);
    expect(settingsAdmin.current().values.sermonAiEnabled).toBe(true);
    expect(entries()).toEqual([
      expect.objectContaining({ action: 'integration.enable', subject: 'sermon-ai', detail: 'enabled' }),
    ]);
  });

  test('refuses to enable it without a configured credential, and changes nothing', async () => {
    const response = await patching('sermon-ai', { enabled: true });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields).toEqual([expect.objectContaining({ path: 'enabled' })]);
    expect(settingsIO.writes).toEqual([]);
    expect(entries()).toEqual([]);
  });

  test('refuses a switch the environment holds rather than writing a file it would ignore', async () => {
    await rebuild(`locale: en\nanthropicApiKey: ${KEY}\n`, { HOLYDECK_SERMON_AI_ENABLED: 'true' });
    const response = await patching('sermon-ai', { enabled: false });
    expect(response.statusCode).toBe(409);
    expect(settingsIO.writes).toEqual([]);
    expect(entries()).toEqual([]);
  });

  test('answers a settings file it cannot change as a problem, not a server failure', async () => {
    await rebuild(`locale: en\nanthropicApiKey: ${KEY}\n`);
    settingsIO.files.set(PATH, 'port: [not, a, port]\n');
    const response = await patching('sermon-ai', { enabled: true });
    expect(response.statusCode).toBe(422);
    expect(entries()).toEqual([]);
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
