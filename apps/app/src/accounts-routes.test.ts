import { ACCOUNTS_PATH, actorFor } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { VALIDATION_FAILED } from '@holydeck/contracts/http';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { accountContext, accountsOn } from './accounts.js';
import { serveAccountRoutes } from './accounts-routes.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { FORBIDDEN, guardMutations, mutatingRoutesOf } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { passkeysOn } from './passkeys.js';
import { ACCOUNTS_MANAGE } from './roles.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { Identity } from './onboarding.js';
import type { Document } from './repositories.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance, InjectOptions } from 'fastify';

const NOW = '2026-09-13T09:30:00.000Z';
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const ID = 'A'.repeat(22);
const UNKNOWN_ID = 'Z'.repeat(22);
const CORRELATION = 'req-0f9c2a41';

/** The administrator granting Control presentation is not the account it is granted to. */
const ADMINISTRATOR = actorFor('C'.repeat(22));

const CLAIM = { name: 'lucia', displayName: 'Lucia Brandt', password: 'a-long-enough-passphrase' };

const controlPath = (id: string): string => `${ACCOUNTS_PATH}/${id}/control-presentation`;

let app: FastifyInstance;
let sessions: SessionStore;
let trail: FakeDb;
let identity: Identity;
let admin: StartedSession;

const now = (): string => NOW;

const entries = (): Document[] => trail.rows.get('audit_events') ?? [];

const actions = (): unknown[] => entries().map((entry) => entry['action']);

const asking = (url: string, payload: unknown, held: StartedSession = admin) =>
  app.inject({
    method: 'PATCH',
    url,
    headers: {
      [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
      host: HOST,
      'x-forwarded-proto': 'https',
      origin: ORIGIN,
      cookie: sessionCookie(held.token, 60),
      [CSRF_HEADER]: held.record.csrf,
    },
    payload: payload as InjectOptions['payload'],
  });

beforeEach(async () => {
  trail = fakeDb();
  sessions = sessionsOn(memorySessions().db, { now });
  const accounts = accountsOn(memoryAccounts().db, {
    now,
    newId: () => ID,
    hash: async (password) => `test-hash:${password}`,
    verify: async (password, stored) => stored === `test-hash:${password}`,
  });
  await accounts.claim(accountContext('req-1a2b3c4d'), CLAIM);
  identity = {
    accounts,
    audit: auditOn(trail, { now, newId: () => `e${entries().length}` }),
    attempts: attemptsOn(memoryAttempts().db, { now }),
    totp: totpsOn(memoryTotp().db, { now }),
    passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
  app = Fastify({ logger: false });
  withSafeErrors(app);
  guardMutations(app, { sessions });
  enforceAuthorization(app, { sessions });
  serveAccountRoutes(app, { identity });
  await app.ready();
  admin = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [ACCOUNTS_MANAGE] });
});

afterEach(async () => {
  await app.close();
});

describe('granting and revoking Control presentation', () => {
  test('grants it to an account that did not have it', async () => {
    const response = await asking(controlPath(ID), { granted: true });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ id: ID, controlPresentation: true });
    const read = await identity.accounts.read(accountContext(CORRELATION), ID);
    expect(read?.controlPresentation).toBe(true);
  });

  test('revokes it from an account that had it, exactly as it was granted', async () => {
    await asking(controlPath(ID), { granted: true });
    const response = await asking(controlPath(ID), { granted: false });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ id: ID, controlPresentation: false });
  });

  test('answers not-found for an account nothing holds', async () => {
    const response = await asking(controlPath(UNKNOWN_ID), { granted: true });
    expect(response.statusCode).toBe(404);
  });

  test('a body that is not a grant is said plainly, because this caller has already proved who they are', async () => {
    const response = await asking(controlPath(ID), { granted: 'yes' });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(response.json().error.fields[0].path).toBe('grant.granted');
  });
});

describe('who may ask it', () => {
  test('every route here changes something, and so it is behind the guard', () => {
    expect(mutatingRoutesOf(app)).toEqual([{ method: 'PATCH', url: controlPath(':id') }]);
  });

  test('refuses a request that carries no session at all', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: controlPath(ID),
      headers: { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current), host: HOST, origin: ORIGIN },
      payload: { granted: true },
    });
    expect(response.statusCode).toBe(401);
  });

  test('refuses a session that carries no accounts.manage permission, however the client hid the control', async () => {
    const guest = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [] });
    const response = await asking(controlPath(ID), { granted: true }, guest);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(FORBIDDEN);
  });
});

describe('the trail this route writes', () => {
  test('records who granted or revoked Control presentation, and for which account', async () => {
    await asking(controlPath(ID), { granted: true });
    expect(actions()).toEqual(['account.control']);
    expect(entries()[0]).toMatchObject({ actor: ADMINISTRATOR, subject: actorFor(ID), outcome: 'allowed' });
  });

  test('writes nothing for an account nothing holds', async () => {
    await asking(controlPath(UNKNOWN_ID), { granted: true });
    expect(entries()).toEqual([]);
  });
});

describe('what this surface refuses to answer at all', () => {
  const serving = async (bag: Identity | undefined): Promise<FastifyInstance> => {
    const built = Fastify({ logger: false });
    withSafeErrors(built);
    guardMutations(built, { sessions });
    enforceAuthorization(built, { sessions });
    serveAccountRoutes(built, { identity: bag });
    await built.ready();
    return built;
  };

  test('a deployment that keeps no accounts serves the path, and answers not-found from it', async () => {
    await app.close();
    app = await serving(undefined);
    const response = await asking(controlPath(ID), { granted: true });
    expect(response.statusCode).toBe(404);
  });

  test('a trail that refuses an entry does not cost the account the grant', async () => {
    await app.close();
    app = await serving({ ...identity, audit: { record: () => Promise.reject(new Error('the trail is unavailable')) } });
    const response = await asking(controlPath(ID), { granted: true });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ controlPresentation: true });
  });
});
