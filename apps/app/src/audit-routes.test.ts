import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { VALIDATION_FAILED } from '@holydeck/contracts/http';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { AUDIT_PATH, serveAuditRoutes } from './audit-routes.js';
import { auditContext, auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { guardMutations } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { passkeysOn } from './passkeys.js';
import { AUDIT_READ } from './roles.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { Identity } from './onboarding.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance } from 'fastify';

const NOW = '2026-09-13T09:30:00.000Z';
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const CORRELATION = 'req-0f9c2a41';
const ADMINISTRATOR = 'account:' + 'C'.repeat(22);

let app: FastifyInstance;
let sessions: SessionStore;
let trail: FakeDb;
let identity: Identity;
let admin: StartedSession;

const now = (): string => NOW;

const withHeaders = (held: StartedSession = admin) => ({
  [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
  host: HOST,
  'x-forwarded-proto': 'https',
  origin: ORIGIN,
  cookie: sessionCookie(held.token, 60),
  [CSRF_HEADER]: held.record.csrf,
});

const asking = (query = '', held: StartedSession = admin) =>
  app.inject({ method: 'GET', url: `${AUDIT_PATH}${query}`, headers: withHeaders(held) });

const serving = async (held: Identity | undefined): Promise<FastifyInstance> => {
  const built = Fastify({ logger: false });
  withSafeErrors(built);
  guardMutations(built, { sessions });
  enforceAuthorization(built, { sessions, identity: held });
  serveAuditRoutes(built, { identity: held });
  await built.ready();
  return built;
};

const seed = async (n: number): Promise<void> => {
  const context = auditContext(ADMINISTRATOR, CORRELATION);
  for (let i = 0; i < n; i += 1) {
    await identity.audit.record(context, { action: 'settings.update', subject: 'settings', outcome: 'allowed' });
  }
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
    audit: auditOn(trail, { now, newId: (() => { let n = 0; return () => `e${n++}`; })() }),
    attempts: attemptsOn(memoryAttempts().db, { now }),
    totp: totpsOn(memoryTotp().db, { now }),
    passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
  app = await serving(identity);
  admin = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [AUDIT_READ] });
});

afterEach(async () => {
  await app.close();
});

describe('listing the audit trail', () => {
  test('answers a page of entries, newest first', async () => {
    await seed(2);
    const response = await asking();
    expect(response.statusCode).toBe(200);
    const { entries } = response.json().data as { entries: unknown[] };
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ action: 'settings.update', subject: 'settings', outcome: 'allowed' });
  });

  test('narrows by category', async () => {
    await seed(1);
    const context = auditContext(ADMINISTRATOR, CORRELATION);
    await identity.audit.record(context, { action: 'instance.claim', subject: 'lucia', outcome: 'allowed' });
    const response = await asking('?category=authentication');
    expect(response.statusCode).toBe(200);
    const { entries } = response.json().data as { entries: { action: string }[] };
    expect(entries).toEqual([expect.objectContaining({ action: 'instance.claim' })]);
  });

  test('pages by limit, offering a cursor for what did not fit', async () => {
    await seed(3);
    const response = await asking('?limit=2');
    expect(response.statusCode).toBe(200);
    const page = response.json().data as { entries: unknown[]; nextCursor?: { at: string; id: string } };
    expect(page.entries).toHaveLength(2);
    expect(page.nextCursor).toBeDefined();
  });

  test('refuses a session granted no permission here', async () => {
    const guest = await sessions.start(sessionContext(CORRELATION), { actor: 'account:' + 'D'.repeat(22), permissions: [] });
    const response = await asking('', guest);
    expect(response.statusCode).toBe(403);
  });

  test('422s a category this release does not declare', async () => {
    const response = await asking('?category=nope');
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(response.json().error.fields).toContainEqual(expect.objectContaining({ path: 'query.category' }));
  });

  test('422s an action this release does not declare', async () => {
    const response = await asking('?action=nope');
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(response.json().error.fields).toContainEqual(expect.objectContaining({ path: 'query.action' }));
  });

  test('422s a query the contract itself refuses, such as an outcome outside its own vocabulary', async () => {
    const response = await asking('?outcome=maybe');
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
  });
});

describe('a deployment with nowhere to keep an identity', () => {
  test('404s, the same as any other route an absent dependency withdraws', async () => {
    await app.close();
    app = await serving(undefined);
    admin = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [AUDIT_READ] });
    const response = await asking();
    expect(response.statusCode).toBe(404);
  });
});
