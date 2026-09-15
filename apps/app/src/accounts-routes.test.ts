import { ACCOUNTS_PATH, actorFor } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { UNEXPECTED_ERROR, VALIDATION_FAILED } from '@holydeck/contracts/http';
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

const statusPath = (id: string): string => `${ACCOUNTS_PATH}/${id}/status`;

const rolePath = (id: string): string => `${ACCOUNTS_PATH}/${id}/role`;

const NEW_ACCOUNT = { name: 'nuwan', displayName: 'Nuwan Perera', password: 'a-long-enough-passphrase', role: 'editor' };

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

const posting = (url: string, payload: unknown, held: StartedSession = admin) =>
  app.inject({
    method: 'POST',
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

// The founder always takes the first identifier this fixture hands out, so every existing test that
// names the founder by `ID` keeps naming the same account; an account this suite creates takes the next.
let nextIds: string[];

beforeEach(async () => {
  trail = fakeDb();
  sessions = sessionsOn(memorySessions().db, { now });
  nextIds = [ID, 'D'.repeat(22), 'E'.repeat(22), 'F'.repeat(22)];
  const accounts = accountsOn(memoryAccounts().db, {
    now,
    newId: () => nextIds.shift() ?? 'Y'.repeat(22),
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
  enforceAuthorization(app, { sessions, identity: undefined });
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

describe('creating an account beyond the one the founder claims', () => {
  test('creates an account of the role asked, and never answers with the credential', async () => {
    const response = await posting(ACCOUNTS_PATH, NEW_ACCOUNT);
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      name: 'nuwan',
      displayName: 'Nuwan Perera',
      role: 'editor',
      disabled: false,
    });
    expect(JSON.stringify(response.json().data)).not.toContain('credential');
  });

  test('refuses a name another account already holds, as a field problem rather than a new status code', async () => {
    const response = await posting(ACCOUNTS_PATH, { ...NEW_ACCOUNT, name: CLAIM.name });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(response.json().error.fields[0].path).toBe('name');
  });

  test('a body that is not a valid new account is said plainly', async () => {
    const response = await posting(ACCOUNTS_PATH, { ...NEW_ACCOUNT, role: 'archbishop' });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(response.json().error.fields[0].path).toBe('newAccount.role');
  });

  test('a failure the store did not name as a duplicate is this server’s own, not a name refused', async () => {
    identity = { ...identity, accounts: { ...identity.accounts, create: () => Promise.reject(new Error('the store is unreachable')) } };
    await app.close();
    app = Fastify({ logger: false });
    withSafeErrors(app);
    guardMutations(app, { sessions });
    enforceAuthorization(app, { sessions, identity: undefined });
    serveAccountRoutes(app, { identity });
    await app.ready();
    const response = await posting(ACCOUNTS_PATH, NEW_ACCOUNT);
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe(UNEXPECTED_ERROR);
  });
});

describe('closing an account, and reopening it', () => {
  test('disables the account named, and a later read answers with that', async () => {
    const created = await posting(ACCOUNTS_PATH, NEW_ACCOUNT);
    const id = created.json().data.id as string;
    const response = await asking(statusPath(id), { disabled: true });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ id, disabled: true });
  });

  test('restores it the same way, when asked for disabled: false', async () => {
    const created = await posting(ACCOUNTS_PATH, NEW_ACCOUNT);
    const id = created.json().data.id as string;
    await asking(statusPath(id), { disabled: true });
    const response = await asking(statusPath(id), { disabled: false });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ id, disabled: false });
  });

  test('answers not-found for an account nothing holds', async () => {
    const response = await asking(statusPath(UNKNOWN_ID), { disabled: true });
    expect(response.statusCode).toBe(404);
  });

  test('a body that is not a status is said plainly', async () => {
    const response = await asking(statusPath(ID), { disabled: 'yes' });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields[0].path).toBe('status.disabled');
  });
});

describe('reassigning an account’s role', () => {
  test('assigns the role asked, and a later read answers with that', async () => {
    const created = await posting(ACCOUNTS_PATH, NEW_ACCOUNT);
    const id = created.json().data.id as string;
    const response = await asking(rolePath(id), { role: 'member' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ id, role: 'member' });
  });

  test('answers not-found for an account nothing holds', async () => {
    const response = await asking(rolePath(UNKNOWN_ID), { role: 'member' });
    expect(response.statusCode).toBe(404);
  });

  test('a body that is not a role assignment is said plainly', async () => {
    const response = await asking(rolePath(ID), { role: 'archbishop' });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields[0].path).toBe('roleAssignment.role');
  });
});

describe('who may ask any of it', () => {
  test('every route here changes something, and so every one is behind the guard', () => {
    expect(mutatingRoutesOf(app)).toEqual([
      { method: 'PATCH', url: controlPath(':id') },
      { method: 'POST', url: ACCOUNTS_PATH },
      { method: 'PATCH', url: statusPath(':id') },
      { method: 'PATCH', url: rolePath(':id') },
    ]);
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

  test('refuses a session that carries no accounts.manage permission, for every route here', async () => {
    const guest = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [] });
    for (const response of [
      await asking(controlPath(ID), { granted: true }, guest),
      await posting(ACCOUNTS_PATH, NEW_ACCOUNT, guest),
      await asking(statusPath(ID), { disabled: true }, guest),
      await asking(rolePath(ID), { role: 'member' }, guest),
    ]) {
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe(FORBIDDEN);
    }
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

  test('records who created an account, and for which new account', async () => {
    const response = await posting(ACCOUNTS_PATH, NEW_ACCOUNT);
    expect(actions()).toEqual(['account.create']);
    expect(entries()[0]).toMatchObject({
      actor: ADMINISTRATOR,
      subject: actorFor(response.json().data.id as string),
      outcome: 'allowed',
    });
  });

  test('records that an account was disabled, and separately that one was restored', async () => {
    const created = await posting(ACCOUNTS_PATH, NEW_ACCOUNT);
    const id = created.json().data.id as string;
    await asking(statusPath(id), { disabled: true });
    await asking(statusPath(id), { disabled: false });
    expect(actions()).toEqual(['account.create', 'account.disable', 'account.restore']);
  });

  test('names the role an account was assigned in the entry’s detail', async () => {
    const created = await posting(ACCOUNTS_PATH, NEW_ACCOUNT);
    const id = created.json().data.id as string;
    await asking(rolePath(id), { role: 'member' });
    expect(actions()).toEqual(['account.create', 'account.role']);
    expect(entries()[1]).toMatchObject({ detail: 'now member' });
  });
});

describe('what this surface refuses to answer at all', () => {
  const serving = async (bag: Identity | undefined): Promise<FastifyInstance> => {
    const built = Fastify({ logger: false });
    withSafeErrors(built);
    guardMutations(built, { sessions });
    enforceAuthorization(built, { sessions, identity: undefined });
    serveAccountRoutes(built, { identity: bag });
    await built.ready();
    return built;
  };

  test('a deployment that keeps no accounts serves every path, and answers not-found from each', async () => {
    await app.close();
    app = await serving(undefined);
    expect((await asking(controlPath(ID), { granted: true })).statusCode).toBe(404);
    expect((await posting(ACCOUNTS_PATH, NEW_ACCOUNT)).statusCode).toBe(404);
    expect((await asking(statusPath(ID), { disabled: true })).statusCode).toBe(404);
    expect((await asking(rolePath(ID), { role: 'member' })).statusCode).toBe(404);
  });

  test('a trail that refuses an entry does not cost the account the grant', async () => {
    await app.close();
    app = await serving({ ...identity, audit: { record: () => Promise.reject(new Error('the trail is unavailable')) } });
    const response = await asking(controlPath(ID), { granted: true });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ controlPresentation: true });
  });
});
