import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { VALIDATION_FAILED } from '@holydeck/contracts/http';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { FORBIDDEN, guardMutations, mutatingRoutesOf } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { passkeysOn } from './passkeys.js';
import { SETTINGS_MANAGE } from './roles.js';
import { settingsAdminOn } from './settings-admin.js';
import { SETTINGS_PATH, serveSettingsRoutes } from './settings-routes.js';
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
const TOKEN = 'c'.repeat(24);
const PATH = CANONICAL_SETTINGS_PATH;

const seed = () =>
  loadSettings({ fileText: `corpusUrl: http://corpus:8080\ncorpusToken: ${TOKEN}\n`, env: {}, path: PATH });

let app: FastifyInstance;
let sessions: SessionStore;
let trail: FakeDb;
let identity: Identity;
let settingsAdmin: SettingsAdmin;
let admin: StartedSession;

const now = (): string => NOW;

const entries = (): Document[] => trail.rows.get('audit_events') ?? [];

const actions = (): unknown[] => entries().map((entry) => entry['action']);

const withHeaders = (held: StartedSession = admin) => ({
  [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
  host: HOST,
  'x-forwarded-proto': 'https',
  origin: ORIGIN,
  cookie: sessionCookie(held.token, 60),
  [CSRF_HEADER]: held.record.csrf,
});

const reading = (held: StartedSession = admin) =>
  app.inject({ method: 'GET', url: SETTINGS_PATH, headers: withHeaders(held) });

const patching = (payload: unknown, held: StartedSession = admin) =>
  app.inject({ method: 'PATCH', url: SETTINGS_PATH, headers: withHeaders(held), payload: payload as never });

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
  const io = fakeSettingsIO({ [PATH]: `corpusUrl: http://corpus:8080\ncorpusToken: ${TOKEN}\n` });
  settingsAdmin = settingsAdminOn(seed(), { ...io, env: {} });
  app = Fastify({ logger: false });
  withSafeErrors(app);
  guardMutations(app, { sessions });
  enforceAuthorization(app, { sessions, identity: undefined });
  serveSettingsRoutes(app, { settingsAdmin, identity });
  await app.ready();
  admin = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [SETTINGS_MANAGE] });
});

afterEach(async () => {
  await app.close();
});

describe('reading the settings', () => {
  test('answers the effective values, their sources, and any pending reload error', async () => {
    const response = await reading();
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      sources: { corpusUrl: 'file', corpusToken: 'file', locale: 'default' },
    });
    expect(response.json().data.lastReloadError).toBeUndefined();
  });

  test('never sends the corpus credential back verbatim', async () => {
    const response = await reading();
    expect(response.body).not.toContain(TOKEN);
  });

  test('writes nothing to the trail, the same as any other read', async () => {
    await reading();
    expect(entries()).toEqual([]);
  });
});

describe('changing a setting', () => {
  test('applies the change, and a later read shows it', async () => {
    const response = await patching({ locale: 'de' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.values).toMatchObject({ locale: 'de' });
    expect((await reading()).json().data.values).toMatchObject({ locale: 'de' });
  });

  test('refuses a body that is not an object, without touching the file', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: SETTINGS_PATH,
      headers: { ...withHeaders(), 'content-type': 'application/json' },
      payload: JSON.stringify('nope'),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(response.json().error.fields[0].path).toBe('settings');
  });

  test('refuses a partial update that mixes a valid field with an invalid one, applying neither', async () => {
    const response = await patching({ locale: 'de', port: 0 });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(response.json().error.fields[0]).toMatchObject({ path: 'settings', code: 'field.not_allowed' });
    expect((await reading()).json().data.values).toMatchObject({ locale: 'en', port: 3000 });
  });

  // The protected setting, from the only direction that matters: this request holds SETTINGS_MANAGE,
  // the highest thing this surface asks for, and still cannot turn developer diagnostics on. It is
  // refused because `update()` validates the whole merged file through the loader, and the loader will
  // not read this setting out of a file at all — so turning it on means reaching the deployment itself.
  test('cannot turn developer diagnostics on, even holding the permission that manages settings', async () => {
    const response = await patching({ developmentDiagnostics: true });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(response.json().error.fields[0]).toMatchObject({ path: 'settings', code: 'field.not_allowed' });
    expect((await reading()).json().data.values).toMatchObject({ developmentDiagnostics: false });
  });

  test('cannot turn them on alongside a change that would otherwise be applied', async () => {
    const response = await patching({ locale: 'de', developmentDiagnostics: true });
    expect(response.statusCode).toBe(422);
    expect((await reading()).json().data.values).toMatchObject({ locale: 'en', developmentDiagnostics: false });
  });

  test('an unexpected failure while writing is not turned into a validation refusal', async () => {
    const io = fakeSettingsIO({ [PATH]: `corpusUrl: http://corpus:8080\ncorpusToken: ${TOKEN}\n` });
    io.failNextRename('the disk is full');
    settingsAdmin = settingsAdminOn(seed(), { ...io, env: {} });
    await app.close();
    app = Fastify({ logger: false });
    withSafeErrors(app);
    guardMutations(app, { sessions });
    enforceAuthorization(app, { sessions, identity: undefined });
    serveSettingsRoutes(app, { settingsAdmin, identity });
    await app.ready();

    const response = await patching({ locale: 'de' });

    expect(response.statusCode).toBe(500);
  });
});

describe('who may ask any of it', () => {
  test('every route here changes something, and so it is behind the guard', () => {
    expect(mutatingRoutesOf(app)).toEqual([{ method: 'PATCH', url: SETTINGS_PATH }]);
  });

  test('refuses a request that carries no session at all', async () => {
    const response = await app.inject({
      method: 'GET',
      url: SETTINGS_PATH,
      headers: { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current), host: HOST, origin: ORIGIN },
    });
    expect(response.statusCode).toBe(401);
  });

  test('refuses a session that carries no settings.manage permission, for both routes', async () => {
    const guest = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [] });
    for (const response of [await reading(guest), await patching({ locale: 'de' }, guest)]) {
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe(FORBIDDEN);
    }
  });
});

describe('the trail this route writes', () => {
  test('records exactly one entry per change, naming the fields and never a value', async () => {
    await patching({ locale: 'de', mediaRoot: '/data/holydeck/other-media' });
    expect(actions()).toEqual(['settings.update']);
    expect(entries()[0]).toMatchObject({ actor: ADMINISTRATOR, subject: 'settings' });
    expect(JSON.stringify(entries()[0])).not.toContain('/data/holydeck/other-media');
    expect(JSON.stringify(entries()[0])).toContain('locale');
    expect(JSON.stringify(entries()[0])).toContain('mediaRoot');
  });

  test('writes nothing for a change the file refused', async () => {
    await patching({ port: 0 });
    expect(entries()).toEqual([]);
  });

  test('a trail that refuses an entry does not cost the change', async () => {
    identity = { ...identity, audit: { record: () => Promise.reject(new Error('the trail is unavailable')) } };
    await app.close();
    app = Fastify({ logger: false });
    withSafeErrors(app);
    guardMutations(app, { sessions });
    enforceAuthorization(app, { sessions, identity: undefined });
    serveSettingsRoutes(app, { settingsAdmin, identity });
    await app.ready();
    const response = await patching({ locale: 'de' });
    expect(response.statusCode).toBe(200);
  });
});

describe('what this surface refuses to answer at all', () => {
  test('a deployment that keeps neither serves both paths, and answers not-found from each', async () => {
    await app.close();
    app = Fastify({ logger: false });
    withSafeErrors(app);
    guardMutations(app, { sessions });
    enforceAuthorization(app, { sessions, identity: undefined });
    serveSettingsRoutes(app, { settingsAdmin: undefined, identity: undefined });
    await app.ready();
    expect((await reading()).statusCode).toBe(404);
    expect((await patching({ locale: 'de' })).statusCode).toBe(404);
  });

  test('answers not-found from the identity gate alone, even with a settings admin configured', async () => {
    await app.close();
    app = Fastify({ logger: false });
    withSafeErrors(app);
    guardMutations(app, { sessions });
    enforceAuthorization(app, { sessions, identity: undefined });
    serveSettingsRoutes(app, { settingsAdmin, identity: undefined });
    await app.ready();
    expect((await reading()).statusCode).toBe(404);
    expect((await patching({ locale: 'de' })).statusCode).toBe(404);
  });
});
