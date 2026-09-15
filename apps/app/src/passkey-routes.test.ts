import { actorFor } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { NOT_FOUND, UNEXPECTED_ERROR, VALIDATION_FAILED } from '@holydeck/contracts/http';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import {
  PASSKEY_LIMIT,
  PASSKEY_OPTIONS_PATH,
  PASSKEY_PATH,
  RELYING_PARTY_NAME,
  passkeyPath,
} from '@holydeck/contracts/webauthn';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ACCOUNTS_COLLECTION, accountContext, accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { FORBIDDEN, guardMutations, mutatingRoutesOf } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { PASSKEY_LIMIT_REACHED, PASSKEY_REFUSED, PASSKEY_REGISTERED, servePasskeyRoutes } from './passkey-routes.js';
import { passkeyContext, passkeysOn } from './passkeys.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';
import { webauthnDevice } from '../test/helpers/webauthn-device.js';

import type { AccountDb } from './accounts.js';
import type { Identity } from './onboarding.js';
import type { PasskeyStore } from './passkeys.js';
import type { Document } from './repositories.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { RegisterOptions, WebAuthnDevice } from '../test/helpers/webauthn-device.js';
import type { FastifyInstance, InjectOptions } from 'fastify';

const NOW = '2026-09-13T09:30:00.000Z';
const HOST = 'holydeck.example.invalid';
const ORIGIN = `https://${HOST}`;
const ELSEWHERE = 'https://passkeys.example.invalid';
const ID = 'A'.repeat(22);
const OTHER_ID = 'B'.repeat(22);
const CORRELATION = 'req-0f9c2a41';

const CLAIM = { name: 'lucia', displayName: 'Lucia Brandt', password: 'a-long-enough-passphrase' };

let app: FastifyInstance;
let sessions: SessionStore;
let passkeys: PasskeyStore;
let accountsDb: AccountDb;
let trail: FakeDb;
let identity: Identity;
let session: StartedSession;
let device: WebAuthnDevice;
let clock: number;

const now = (): string => new Date(clock).toISOString();

const entries = (): Document[] => trail.rows.get('audit_events') ?? [];

const actions = (): unknown[] => entries().map((entry) => entry['action']);

const asking = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, held = session) =>
  app.inject({
    method,
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

const reading = (held: StartedSession | undefined) =>
  app.inject({
    method: 'GET',
    url: PASSKEY_PATH,
    headers: {
      [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
      host: HOST,
      ...(held === undefined ? {} : { cookie: sessionCookie(held.token, 60) }),
    },
  });

/** The options a browser would be handed, which is where the challenge a ceremony answers comes from. */
const offered = async (held = session): Promise<Record<string, unknown>> =>
  (await asking('POST', PASSKEY_OPTIONS_PATH, undefined, held)).json().data;

/** What the browser sends back, flattened the way the contract's parser hands it to a route. */
const answered = (challenge: string, options?: RegisterOptions, made: WebAuthnDevice = device) => {
  const produced = made.register(challenge, options);
  return {
    id: produced.id,
    rawId: produced.rawId,
    type: produced.type,
    response: {
      clientDataJSON: produced.response.clientDataJSON,
      attestationObject: produced.response.attestationObject,
      transports: produced.response.transports,
    },
  };
};

/** A whole registration: draw the options, answer them on the device, and send the answer back. */
const registering = async (name = 'the phone in my pocket', options?: RegisterOptions, held = session) => {
  const challenge = String((await offered(held))['challenge']);
  return asking('POST', PASSKEY_PATH, { name, credential: answered(challenge, options) }, held);
};

const listed = async (held = session): Promise<Record<string, unknown>[]> =>
  (await reading(held)).json().data.passkeys as Record<string, unknown>[];

beforeEach(async () => {
  clock = Date.parse(NOW);
  trail = fakeDb();
  device = webauthnDevice({ rpId: HOST, origin: ORIGIN });
  sessions = sessionsOn(memorySessions().db, { now });
  passkeys = passkeysOn(memoryPasskeys().db, { now });
  let issued = 0;
  accountsDb = memoryAccounts().db;
  const accounts = accountsOn(accountsDb, {
    now,
    newId: () => {
      issued += 1;
      return issued === 1 ? ID : OTHER_ID;
    },
    hash: async (password) => `test-hash:${password}`,
    verify: async (password, stored) => stored === `test-hash:${password}`,
  });
  await accounts.claim(accountContext('req-1a2b3c4d'), CLAIM);
  identity = {
    accounts,
    audit: auditOn(trail, { now, newId: () => `e${entries().length}` }),
    attempts: attemptsOn(memoryAttempts().db, { now }),
    totp: totpsOn(memoryTotp().db, { now }),
    passkeys,
  };
  app = Fastify({ logger: false });
  withSafeErrors(app);
  guardMutations(app, { sessions });
  enforceAuthorization(app, { sessions, identity: undefined });
  servePasskeyRoutes(app, { identity });
  await app.ready();
  session = await sessions.start(sessionContext(CORRELATION), { actor: actorFor(ID), permissions: [] });
});

afterEach(async () => {
  await app.close();
});

describe('the options a registration starts with', () => {
  test('names this deployment and this account, and hands over a challenge drawn for one ceremony', async () => {
    const options = await offered();
    expect(options['rp']).toEqual({ name: RELYING_PARTY_NAME, id: HOST });
    expect(options['user']).toMatchObject({ name: CLAIM.name, displayName: CLAIM.displayName });
    expect(String(options['challenge'])).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    // Drawn fresh every time: a challenge that could be asked for twice is a challenge worth stealing.
    expect((await offered())['challenge']).not.toBe(options['challenge']);
  });

  test('lists the keys the account already holds, so one authenticator is not registered twice', async () => {
    await registering();
    expect((await offered())['excludeCredentials']).toEqual([
      { id: device.credentialId, type: 'public-key', transports: ['internal'] },
    ]);
  });

  test('a session no account holds is refused, because a passkey belongs to an account', async () => {
    const service = await sessions.start(sessionContext(CORRELATION), { actor: 'service:lights', permissions: [] });
    const response = await asking('POST', PASSKEY_OPTIONS_PATH, undefined, service);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(FORBIDDEN);
  });

  test('a session for an account this server no longer holds draws no options', async () => {
    const stale = await sessions.start(sessionContext(CORRELATION), { actor: actorFor(OTHER_ID), permissions: [] });
    const response = await asking('POST', PASSKEY_OPTIONS_PATH, undefined, stale);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(FORBIDDEN);
  });
});

describe('registering a key', () => {
  test('keeps the key the ceremony proved, and answers what a list of them says', async () => {
    const response = await registering();
    expect(response.statusCode).toBe(201);
    expect(response.json().data.passkey).toEqual({
      id: device.credentialId,
      name: 'the phone in my pocket',
      registeredAt: NOW,
      transports: ['internal'],
      synced: false,
    });
    expect(actions()).toEqual(['passkey.register']);
  });

  test('a session no account holds may not register a key, because it does not have one to hold it', async () => {
    const service = await sessions.start(sessionContext(CORRELATION), { actor: 'service:lights', permissions: [] });
    const response = await asking('POST', PASSKEY_PATH, { name: 'x', credential: answered('y') }, service);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(FORBIDDEN);
  });

  test('a body that is not a registration is refused for being one, and nothing is kept', async () => {
    const response = await asking('POST', PASSKEY_PATH, { name: '', credential: {} });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(await listed()).toEqual([]);
  });

  test('a credential whose client data carries no readable challenge is refused, and nothing is kept', async () => {
    const noChallenge = Buffer.from(JSON.stringify({ type: 'webauthn.create' })).toString('base64url');
    const response = await asking('POST', PASSKEY_PATH, {
      name: 'the phone in my pocket',
      credential: {
        id: device.credentialId,
        rawId: device.credentialId,
        type: 'public-key',
        response: {
          clientDataJSON: noChallenge,
          attestationObject: Buffer.from('attestation').toString('base64url'),
          transports: ['internal'],
        },
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe(PASSKEY_REFUSED);
    expect(actions()).toEqual(['passkey.register']);
    expect(entries()[0]?.['detail']).toBe('no readable challenge');
    expect(await listed()).toEqual([]);
  });

  test('an answer to a challenge this server never issued is refused, and says only that', async () => {
    const response = await asking('POST', PASSKEY_PATH, {
      name: 'the phone in my pocket',
      credential: answered('a-challenge-nobody-here-ever-drew'),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe(PASSKEY_REFUSED);
    expect(await listed()).toEqual([]);
  });

  test('a challenge is answerable once, so the same answer sent twice is refused the second time', async () => {
    const challenge = String((await offered())['challenge']);
    const credential = answered(challenge);
    const body = { name: 'the phone in my pocket', credential };
    await expect(asking('POST', PASSKEY_PATH, body)).resolves.toMatchObject({ statusCode: 201 });
    await expect(asking('POST', PASSKEY_PATH, body)).resolves.toMatchObject({ statusCode: 401 });
  });

  test('a challenge drawn for another account is not answerable inside this session', async () => {
    const other = await accounts_other();
    const challenge = await passkeys.challenge(passkeyContext(CORRELATION), 'registration', other);
    const response = await asking('POST', PASSKEY_PATH, {
      name: 'the phone in my pocket',
      credential: answered(challenge),
    });
    expect(response.statusCode).toBe(401);
    expect(await listed()).toEqual([]);
  });

  test('a ceremony answered on another site’s page is refused, whatever it was signed with', async () => {
    const response = await registering('the phone in my pocket', { origin: ELSEWHERE });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe(PASSKEY_REFUSED);
    // What was wrong is written down for an administrator, and not said to whoever asked.
    expect(actions()).toEqual(['passkey.register']);
    expect(entries()[0]?.['outcome']).toBe('refused');
  });

  test('a key this deployment already holds is refused as the one it already holds', async () => {
    await registering();
    const response = await registering('the same phone again');
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(PASSKEY_REGISTERED);
  });

  test('a key over the account’s ceiling is refused, and the ceiling is the contract’s', async () => {
    for (let held = 0; held < PASSKEY_LIMIT; held += 1) {
      await passkeys.register(passkeyContext(CORRELATION), ID, {
        id: `held-${held}`,
        name: `key ${held}`,
        publicKey: 'a-public-key',
        counter: 0,
        transports: ['internal'],
        synced: false,
      });
    }
    const response = await registering();
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(PASSKEY_LIMIT_REACHED);
  });
});

describe('listing the keys an account holds', () => {
  test('says what a person needs to tell their devices apart, and nothing a key is proved with', async () => {
    await registering('the phone in my pocket');
    const keys = await listed();
    expect(keys).toEqual([
      {
        id: device.credentialId,
        name: 'the phone in my pocket',
        registeredAt: NOW,
        transports: ['internal'],
        synced: false,
      },
    ]);
    expect(JSON.stringify(keys)).not.toContain('publicKey');
    expect(JSON.stringify(keys)).not.toContain('counter');
  });

  test('says when a key was last used, once it has been', async () => {
    await registering('the phone in my pocket');
    await passkeys.used(passkeyContext(CORRELATION), device.credentialId, 1);
    expect((await listed())[0]?.['lastUsedAt']).toBe(NOW);
  });

  test('shows an account its own keys and no others', async () => {
    await registering();
    const other = await accounts_other();
    const theirs = await sessions.start(sessionContext(CORRELATION), { actor: actorFor(other), permissions: [] });
    expect(await listed(theirs)).toEqual([]);
  });

  test('a request carrying no session is refused, because a list of keys is an account’s own', async () => {
    const response = await reading(undefined);
    expect(response.statusCode).toBe(401);
  });

  test('a session no account holds is refused, because a list of keys is an account’s own', async () => {
    const service = await sessions.start(sessionContext(CORRELATION), { actor: 'service:lights', permissions: [] });
    const response = await reading(service);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(FORBIDDEN);
  });
});

describe('naming a key', () => {
  test('changes what the list calls it, and writes that down', async () => {
    await registering('the phone in my pocket');
    const response = await asking('PATCH', passkeyPath(device.credentialId), { name: 'the yubikey on my keys' });
    expect(response.statusCode).toBe(200);
    expect((await listed())[0]?.['name']).toBe('the yubikey on my keys');
    expect(actions()).toEqual(['passkey.register', 'passkey.name']);
  });

  test('a session no account holds may not name a key, because it does not have one to name', async () => {
    const service = await sessions.start(sessionContext(CORRELATION), { actor: 'service:lights', permissions: [] });
    const response = await asking('PATCH', passkeyPath(device.credentialId), { name: 'mine now' }, service);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(FORBIDDEN);
  });

  test('a name that is not one is refused before anything is written', async () => {
    await registering('the phone in my pocket');
    const response = await asking('PATCH', passkeyPath(device.credentialId), { name: '   ' });
    expect(response.statusCode).toBe(422);
    expect((await listed())[0]?.['name']).toBe('the phone in my pocket');
  });

  test('a key another account holds is not this account’s to name, and is not found', async () => {
    await registering();
    const other = await accounts_other();
    const theirs = await sessions.start(sessionContext(CORRELATION), { actor: actorFor(other), permissions: [] });
    const response = await asking('PATCH', passkeyPath(device.credentialId), { name: 'mine now' }, theirs);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe(NOT_FOUND);
    expect((await listed())[0]?.['name']).toBe('the phone in my pocket');
  });
});

describe('giving a key up', () => {
  test('removes it, writes that down, and the list no longer shows it', async () => {
    await registering();
    const response = await asking('DELETE', passkeyPath(device.credentialId));
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ revoked: true });
    expect(await listed()).toEqual([]);
    expect(actions()).toEqual(['passkey.register', 'passkey.revoke']);
  });

  test('a session no account holds may not give up a key, because it does not have one to give up', async () => {
    const service = await sessions.start(sessionContext(CORRELATION), { actor: 'service:lights', permissions: [] });
    const response = await asking('DELETE', passkeyPath(device.credentialId), undefined, service);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(FORBIDDEN);
  });

  test('a key another account holds is not this account’s to give up', async () => {
    await registering();
    const other = await accounts_other();
    const theirs = await sessions.start(sessionContext(CORRELATION), { actor: actorFor(other), permissions: [] });
    await expect(asking('DELETE', passkeyPath(device.credentialId), undefined, theirs)).resolves.toMatchObject({
      statusCode: 404,
    });
    expect(await listed()).toHaveLength(1);
  });
});

describe('the surface itself', () => {
  test('every change a passkey needs is behind the guard, and the reads are not changes', () => {
    expect(mutatingRoutesOf(app)).toEqual([
      { method: 'POST', url: PASSKEY_OPTIONS_PATH },
      { method: 'POST', url: PASSKEY_PATH },
      { method: 'PATCH', url: `${PASSKEY_PATH}/:id` },
      { method: 'DELETE', url: `${PASSKEY_PATH}/:id` },
    ]);
  });

  test('a deployment that keeps no accounts serves the paths and answers them as paths it does not', async () => {
    await app.close();
    app = Fastify({ logger: false });
    withSafeErrors(app);
    guardMutations(app, { sessions });
    servePasskeyRoutes(app, { identity: undefined });
    await app.ready();
    for (const response of [
      await asking('POST', PASSKEY_OPTIONS_PATH),
      await asking('POST', PASSKEY_PATH, { name: 'x', credential: answered('y') }),
      await reading(session),
      await asking('PATCH', passkeyPath('x'), { name: 'y' }),
      await asking('DELETE', passkeyPath('x')),
    ]) {
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe(NOT_FOUND);
    }
  });

  test('a trail that refuses an entry is logged, and does not take back a key that was registered', async () => {
    identity = { ...identity, audit: { record: () => Promise.reject(new Error('the trail is full')) } };
    await app.close();
    app = Fastify({ logger: false });
    withSafeErrors(app);
    guardMutations(app, { sessions });
    enforceAuthorization(app, { sessions, identity: undefined });
    servePasskeyRoutes(app, { identity });
    await app.ready();
    await expect(registering()).resolves.toMatchObject({ statusCode: 201 });
    expect(await listed()).toHaveLength(1);
  });

  test('a failure the store did not name as a refusal is this server’s own, not a ceremony refused', async () => {
    identity = {
      ...identity,
      passkeys: { ...passkeys, register: () => Promise.reject(new Error('the store is unreachable')) },
    };
    await app.close();
    app = Fastify({ logger: false });
    withSafeErrors(app);
    guardMutations(app, { sessions });
    servePasskeyRoutes(app, { identity });
    await app.ready();
    const response = await registering();
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe(UNEXPECTED_ERROR);
  });
});

/** A second account, made after the claim, which is how another operator's keys get somewhere to live. */
const accounts_other = async (): Promise<string> => {
  await accountsDb.collection(ACCOUNTS_COLLECTION).insertOne({
    _id: OTHER_ID,
    name: 'mattia',
    displayName: 'Mattia Rossi',
    role: 'admin',
    createdAt: now(),
    credential: 'test-hash:another-long-enough-passphrase',
    founder: false,
  });
  return OTHER_ID;
};
