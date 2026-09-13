import { ONBOARDING_PATH, onboardingOffer } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { VALIDATION_FAILED } from '@holydeck/contracts/http';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { AccountError, accountsOn } from './accounts.js';
import { auditOn } from './audit.js';
import { guardMutations } from './csrf.js';
import { NOT_FOUND, notFound, withSafeErrors } from './failures.js';
import { serveOnboarding } from './onboarding.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { AccountStore } from './accounts.js';
import type { Identity } from './onboarding.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance } from 'fastify';
import type { InjectOptions } from 'fastify';

const NOW = '2026-09-13T09:30:00.000Z';
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const ID = 'A'.repeat(22);

const CLAIM = { name: 'lucia', displayName: 'Lucia Brandt', password: 'a-long-enough-passphrase' };

let app: FastifyInstance;
let accounts: AccountStore;
let rows: Map<string, unknown>;
let trailDb: FakeDb;

const serving = async (identity: Identity | undefined): Promise<FastifyInstance> => {
  const built = Fastify({ logger: false });
  withSafeErrors(built);
  guardMutations(built, { sessions: undefined });
  built.setNotFoundHandler((request, reply) => reply.code(404).send(notFound(request)));
  serveOnboarding(built, { identity });
  await built.ready();
  return built;
};

const identityOf = (store: AccountStore): Identity => ({
  accounts: store,
  audit: auditOn(trailDb, { now: () => NOW, newId: () => `e${trailDb.rows.get('audit_events')?.length ?? 0}` }),
});

const entries = () => trailDb.rows.get('audit_events') ?? [];

const ask = (method: 'GET' | 'POST', url: string, options: InjectOptions = {}) =>
  app.inject({
    method,
    url,
    headers: {
      [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
      host: HOST,
      'x-forwarded-proto': 'https',
      origin: ORIGIN,
      ...options.headers,
    },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });

const claiming = (payload: unknown = CLAIM, headers: Record<string, string> = {}) =>
  ask('POST', ONBOARDING_PATH, { payload: payload as InjectOptions['payload'], headers });

beforeEach(async () => {
  const memory = memoryAccounts();
  rows = memory.rows as Map<string, unknown>;
  trailDb = fakeDb();
  accounts = accountsOn(memory.db, {
    now: () => NOW,
    newId: () => ID,
    hash: async (password) => `test-hash:${password.length}`,
  });
  app = await serving(identityOf(accounts));
});

afterEach(async () => {
  await app.close();
});

describe('before the instance is claimed', () => {
  test('the route says what a claim has to carry, so a first run needs no documentation beside it', async () => {
    const response = await ask('GET', ONBOARDING_PATH);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(onboardingOffer());
  });

  test('a claim creates exactly one Admin, and answers with the account it created', async () => {
    const response = await claiming();
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toEqual({
      id: ID,
      name: 'lucia',
      displayName: 'Lucia Brandt',
      role: 'admin',
      createdAt: NOW,
    });
    expect(rows.size).toBe(1);
  });

  test('neither the password nor what was derived from it is anywhere in the answer', async () => {
    const response = await claiming();
    expect(response.body).not.toContain(CLAIM.password);
    expect(response.body).not.toContain('test-hash');
    expect(response.body).not.toContain('credential');
  });

  test('the claim is recorded in the trail under the account it created', async () => {
    await claiming();
    expect(entries()).toEqual([
      {
        _id: 'audit:e0',
        actor: `account:${ID}`,
        correlationId: expect.stringMatching(/^claim:/u) as unknown as string,
        at: NOW,
        action: 'instance.claim',
        subject: 'lucia',
        outcome: 'allowed',
      },
    ]);
  });

  test('a claim carrying no origin at all is accepted, because a first run may be made from a terminal', async () => {
    const response = await app.inject({
      method: 'POST',
      url: ONBOARDING_PATH,
      headers: { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current), host: HOST },
      payload: CLAIM,
    });
    expect(response.statusCode).toBe(201);
  });

  test('a claim sent from another site is refused, and creates nothing while refusing', async () => {
    const response = await claiming(CLAIM, { origin: 'https://elsewhere.example.invalid' });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.fields).toMatchObject([{ path: 'origin' }]);
    expect(rows.size).toBe(0);
  });

  test('a body that is not a claim is refused field by field, and creates nothing', async () => {
    const response = await claiming({ name: 'A!', displayName: '', password: 'short' });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    // Each field is named under the object it belongs to, which is how every parser in the contracts
    // package spells a path, so one client can render problems from any of them the same way.
    expect(response.json().error.fields.map((field: { path: string }) => field.path).sort()).toEqual([
      'claim.displayName',
      'claim.name',
      'claim.password',
    ]);
    expect(rows.size).toBe(0);
  });
});

describe('once the instance is claimed', () => {
  beforeEach(async () => {
    expect((await claiming()).statusCode).toBe(201);
  });

  test('the route answers exactly what a path this server never served answers', async () => {
    const missing = await ask('GET', '/api/v1/nothing-here');
    const closed = await ask('GET', ONBOARDING_PATH);
    expect(closed.statusCode).toBe(missing.statusCode);
    expect(closed.json().error.code).toBe(missing.json().error.code);
    expect(closed.json().error.message).toBe(`GET ${ONBOARDING_PATH} is not a path this server serves.`);
  });

  test('a second claim is refused as not-found, whatever handle it asks for, and changes nothing', async () => {
    const response = await claiming({ ...CLAIM, name: 'andrew' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe(NOT_FOUND);
    expect(rows.size).toBe(1);
  });

  test('the refused claim is in the trail, which is the only place it is visible at all', async () => {
    await claiming({ ...CLAIM, name: 'andrew' });
    expect(entries()[1]).toMatchObject({
      actor: 'system',
      action: 'instance.claim',
      subject: 'andrew',
      outcome: 'refused',
    });
  });

  // The promise is that this route is indistinguishable from a path the server never served, and a
  // validation problem breaks it more cheaply than anything else could: it takes no handle and no
  // password to post an empty body, and the answer alone says the deployment is installed and in use.
  test('a body that is not a claim at all is answered the same way, not as a validation problem', async () => {
    const response = await claiming({});
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe(NOT_FOUND);
  });

  test('a foreign origin is answered the same way too, because a closed route has nothing to refuse for', async () => {
    const response = await claiming(CLAIM, { origin: 'https://elsewhere.example.invalid' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe(NOT_FOUND);
  });

  test('an attempt that named no handle is in the trail under none, rather than not being in it at all', async () => {
    await claiming({});
    expect(entries()[1]).toMatchObject({ action: 'instance.claim', outcome: 'refused', subject: '(no handle)' });
  });
});

describe('when the trail refuses the entry', () => {
  const deaf = (store: AccountStore): Identity => ({
    accounts: store,
    audit: { record: () => Promise.reject(new Error('the trail is unavailable')) },
  });

  // The trail records what happened; it does not decide it. An account that exists has to be answered as
  // created even when the entry saying so could not be written — the alternative tells an administrator
  // their claim failed, and the claim they make next is refused as a second one, locking them out.
  test('a claim that was made is answered as made', async () => {
    app = await serving(deaf(accounts));
    const response = await claiming();
    expect(response.statusCode).toBe(201);
    expect(rows.size).toBe(1);
  });

  test('a claim refused as a second one is still answered as not-found', async () => {
    expect((await claiming()).statusCode).toBe(201);
    app = await serving(deaf(accounts));
    const response = await claiming({ ...CLAIM, name: 'andrew' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe(NOT_FOUND);
  });
});

describe('a deployment with no accounts to claim', () => {
  test('offers no claim and accepts none, rather than failing once one is made', async () => {
    app = await serving(undefined);
    expect((await ask('GET', ONBOARDING_PATH)).statusCode).toBe(404);
    expect((await claiming()).statusCode).toBe(404);
  });
});

describe('when two claims arrive together', () => {
  // The race the question above cannot settle: both callers were told the instance was unclaimed, and
  // then one of them lost the write. The loser is answered out of the same place in the same words as
  // anyone else who arrives late, and is in the trail beside the claim that won.
  test('the one that lost the write is answered as not-found, and is recorded as having tried', async () => {
    const raced: AccountStore = {
      ...accounts,
      claimed: () => Promise.resolve(false),
      claim: () => Promise.reject(new AccountError('claimed', 'this instance has been claimed already')),
    };
    app = await serving(identityOf(raced));
    const response = await claiming({ ...CLAIM, name: 'andrew' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe(NOT_FOUND);
    expect(entries()[0]).toMatchObject({ actor: 'system', subject: 'andrew', outcome: 'refused' });
  });
});

describe('when the store refuses for any other reason', () => {
  test('the answer is a fault of this server’s, and says nothing about what went wrong', async () => {
    const broken: AccountStore = {
      ...accounts,
      claim: () => Promise.reject(new AccountError('schema', 'mongodb://holydeck:hunter2@records.invalid')),
    };
    app = await serving(identityOf(broken));
    const response = await claiming();
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('hunter2');
    expect(entries()).toHaveLength(0);
  });
});
