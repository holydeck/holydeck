import { PASSWORD, actorFor } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { VALIDATION_FAILED } from '@holydeck/contracts/http';
import {
  CSRF_HEADER,
  SESSION_ABSOLUTE_HOURS,
  SESSION_COOKIE,
  SESSION_PATH,
  TICKET_PATH,
  TICKET_SECONDS,
  clearedSessionCookie,
  cookieIn,
  isOpaqueToken,
  sessionCookie,
} from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { accountContext, accountsOn } from './accounts.js';
import { ACCOUNT_ATTEMPT_LIMIT, LOCK_MINUTES, accountScope, attemptContext, attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { FORBIDDEN, guardMutations, mutatingRoutesOf } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { codeAt, stepAt } from './otp.js';
import { SIGN_IN_REFUSED, serveSessionRoutes } from './session-routes.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { totpContext, totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { AccountStore } from './accounts.js';
import type { AttemptGate } from './attempts.js';
import type { Identity } from './onboarding.js';
import type { SessionRoutesOptions } from './session-routes.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { TotpStore } from './totp.js';
import type { Document } from './repositories.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance, InjectOptions } from 'fastify';

const NOW = '2026-09-13T09:30:00.000Z';
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const ID = 'A'.repeat(22);

const CLAIM = { name: 'lucia', displayName: 'Lucia Brandt', password: 'a-long-enough-passphrase' };

const MINUTE = 60_000;
const HALF_MINUTE = MINUTE / 2;

let app: FastifyInstance;
let store: SessionStore;
let sessionRows: Map<string, Document>;
let accounts: AccountStore;
let attempts: AttemptGate;
let totp: TotpStore;
let trail: FakeDb;
let identity: Identity;
let clock: number;

const now = (): string => new Date(clock).toISOString();

const serving = async (options: SessionRoutesOptions): Promise<FastifyInstance> => {
  const built = Fastify({ logger: false });
  withSafeErrors(built);
  guardMutations(built, { sessions: options.sessions });
  serveSessionRoutes(built, options);
  await built.ready();
  return built;
};

const signedIn = async (): Promise<StartedSession> =>
  store.start(sessionContext('req-0f9c2a41'), { actor: 'account:7f3a', permissions: ['services.read'] });

const asking = (method: 'GET' | 'DELETE' | 'POST', url: string, session: StartedSession | undefined) =>
  app.inject({
    method,
    url,
    headers: {
      [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
      host: HOST,
      'x-forwarded-proto': 'https',
      origin: ORIGIN,
      ...(session === undefined
        ? {}
        : { cookie: sessionCookie(session.token, 60), [CSRF_HEADER]: session.record.csrf }),
    },
  });

const signingIn = (
  payload: unknown = { name: CLAIM.name, password: CLAIM.password },
  headers: Record<string, string | undefined> = {},
) =>
  app.inject({
    method: 'POST',
    url: SESSION_PATH,
    headers: {
      [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
      host: HOST,
      'x-forwarded-proto': 'https',
      origin: ORIGIN,
      ...headers,
    } as Record<string, string>,
    payload: payload as InjectOptions['payload'],
  });

const failing = (password = 'not-the-passphrase', name = CLAIM.name) => signingIn({ name, password });

const withCode = (code: string) => signingIn({ name: CLAIM.name, password: CLAIM.password, code });

/** An account that owes a second factor, with the secret its codes come from and the codes that stand in. */
const owing = async (): Promise<{ readonly secret: string; readonly codes: readonly string[] }> => {
  const { secret } = await totp.enroll(totpContext('req-0f9c2a41'), ID);
  const codes = await totp.verify(totpContext('req-0f9c2a41'), ID, codeAt(secret, stepAt(now())));
  // Proving the enrolment spends that half-minute's code, exactly as signing in with it would, so the
  // clock moves on to the step an operator's first real sign-in would be typing a code from.
  clock += HALF_MINUTE;
  return { secret, codes: codes ?? [] };
};

const entries = (): Document[] => trail.rows.get('audit_events') ?? [];

const tokenIn = (header: unknown): string => cookieIn(String(header), SESSION_COOKIE) ?? '';

beforeEach(async () => {
  clock = Date.parse(NOW);
  trail = fakeDb();
  const sessions = memorySessions();
  sessionRows = sessions.rows;
  store = sessionsOn(sessions.db, { now });
  accounts = accountsOn(memoryAccounts().db, {
    now,
    newId: () => ID,
    hash: async (password) => `test-hash:${password}`,
    verify: async (password, stored) => stored === `test-hash:${password}`,
  });
  attempts = attemptsOn(memoryAttempts().db, { now });
  totp = totpsOn(memoryTotp().db, { now });
  await accounts.claim(accountContext('req-1a2b3c4d'), CLAIM);
  identity = {
    accounts,
    audit: auditOn(trail, { now, newId: () => `e${entries().length}` }),
    attempts,
    totp,
  };
  app = await serving({ sessions: store, identity });
});

afterEach(async () => {
  await app.close();
});

describe('what an operator can ask about their own session', () => {
  test('answers who the session is for and what it may do, without the identifier it travels as', async () => {
    const session = await signedIn();
    const response = await asking('GET', SESSION_PATH, session);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(session.record);
    // The identifier is a cookie the browser sends and script cannot read. It is not in this
    // answer, and there is no route that puts it in a URL either.
    expect(response.body).not.toContain(session.token);
  });

  test('is answered as a request with no session when there is none, and reading one changes nothing', async () => {
    const response = await asking('GET', SESSION_PATH, undefined);
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBe(clearedSessionCookie());
  });

  test('is a safe method, and so is not one the guard is on', async () => {
    // Signing in changes something and is still not in this list: it is the mutation that cannot carry a
    // session, and the guard's declared exception is what lets it past rather than a hole in the guard.
    expect(mutatingRoutesOf(app)).toEqual([
      { method: 'DELETE', url: SESSION_PATH },
      { method: 'POST', url: TICKET_PATH },
    ]);
  });
});

describe('signing in', () => {
  test('a handle and the password it was claimed with open a session, given as a cookie', async () => {
    const response = await signingIn();
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      actor: actorFor(ID),
      rotation: 'authentication',
      // What the operator may do is granted by the roles work; a session that proves who opens nothing.
      permissions: [],
    });
    const cookie = String(response.headers['set-cookie']);
    expect(isOpaqueToken(tokenIn(cookie))).toBe(true);
    expect(cookie).toContain(`Max-Age=${SESSION_ABSOLUTE_HOURS * 3600}`);
    expect(cookie).toContain('HttpOnly');
    // The identifier is in the cookie and nowhere else, the answering body included.
    expect(response.body).not.toContain(tokenIn(cookie));
  });

  test('the session it opens is one the rest of the surface accepts', async () => {
    const opened = await signingIn();
    const cookie = String(opened.headers['set-cookie']);
    const response = await app.inject({
      method: 'GET',
      url: SESSION_PATH,
      headers: { host: HOST, 'x-forwarded-proto': 'https', origin: ORIGIN, cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ actor: actorFor(ID) });
  });

  test('a handle is read the way it was claimed, whatever case and spacing it is typed in', async () => {
    const response = await signingIn({ name: '  LUCIA  ', password: CLAIM.password });
    expect(response.statusCode).toBe(201);
  });

  test('the trail records the sign-in under the account, which is what history is kept by', async () => {
    await signingIn();
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      actor: actorFor(ID),
      action: 'session.signIn',
      subject: CLAIM.name,
      outcome: 'allowed',
    });
  });
});

describe('what a refused sign-in says', () => {
  test('a wrong password and a handle nobody holds are answered in the same words', async () => {
    const wrong = await failing();
    const nobody = await failing('not-the-passphrase', 'nobody');
    expect(wrong.statusCode).toBe(401);
    expect(nobody.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe(SIGN_IN_REFUSED);
    // Everything but the request identifier, which is this request's own and says nothing about accounts.
    expect({ ...wrong.json().error, requestId: '' }).toEqual({ ...nobody.json().error, requestId: '' });
  });

  test('a body that is not a sign-in at all is refused the same way, not as a validation problem', async () => {
    const refusals = [{}, { name: CLAIM.name }, { name: CLAIM.name, password: 'x'.repeat(PASSWORD.maximum + 1) }];
    for (const payload of refusals) {
      const response = await signingIn(payload);
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe(SIGN_IN_REFUSED);
      expect(response.body).not.toContain(VALIDATION_FAILED);
    }
  });

  test('a refusal opens nothing: no cookie is set, and no session is written to keep', async () => {
    const response = await failing();
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(sessionRows.size).toBe(0);
  });

  test('the trail records the attempt under the handle it asked for, with nobody to attribute it to', async () => {
    await failing('not-the-passphrase', 'nobody');
    expect(entries()[0]).toMatchObject({
      actor: 'system',
      action: 'session.signIn',
      subject: 'nobody',
      outcome: 'refused',
    });
  });
});

describe('a second factor, where the account owes one', () => {
  test('the right password alone is refused, in the words a wrong password is refused in', async () => {
    await owing();
    const owed = await signingIn();
    const wrong = await failing();
    expect(owed.statusCode).toBe(401);
    expect(owed.headers['set-cookie']).toBeUndefined();
    expect(sessionRows.size).toBe(0);
    // Whether the password was right is exactly what a caller who did not answer the second factor
    // must not learn, so the two refusals are one answer down to the sentence.
    expect({ ...owed.json().error, requestId: '' }).toEqual({ ...wrong.json().error, requestId: '' });
  });

  test('a code that is not this second factor’s is refused the same way, and so is nonsense', async () => {
    const { secret } = await owing();
    const elsewhere = codeAt(secret, stepAt(now()) + 9);
    for (const code of [elsewhere, 'not-a-code', '']) {
      const response = await withCode(code);
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe(SIGN_IN_REFUSED);
    }
  });

  test('the code opens the session, and the trail records the factor before the sign-in it allowed', async () => {
    const { secret } = await owing();
    const response = await withCode(codeAt(secret, stepAt(now())));
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({ actor: actorFor(ID) });
    expect(entries()).toMatchObject([
      { actor: actorFor(ID), action: 'totp.use', subject: actorFor(ID), outcome: 'allowed' },
      { actor: actorFor(ID), action: 'session.signIn', subject: CLAIM.name, outcome: 'allowed' },
    ]);
  });

  test('a recovery code stands in for the application once, and is gone the second time', async () => {
    const { codes } = await owing();
    const first = String(codes[0]);
    await expect(withCode(first)).resolves.toMatchObject({ statusCode: 201 });
    await expect(withCode(first)).resolves.toMatchObject({ statusCode: 401 });
  });

  test('a code that opened a session does not open a second one, inside the same half-minute', async () => {
    const { secret } = await owing();
    const code = codeAt(secret, stepAt(now()));
    await expect(withCode(code)).resolves.toMatchObject({ statusCode: 201 });
    await expect(withCode(code)).resolves.toMatchObject({ statusCode: 401 });
  });

  test('a wrong code is counted against the handle a wrong password is counted against', async () => {
    const { secret } = await owing();
    for (let attempt = 0; attempt < ACCOUNT_ATTEMPT_LIMIT; attempt += 1) await withCode('000000');
    // The lock is the gate's, and it holds whatever the next request gets right.
    await expect(withCode(codeAt(secret, stepAt(now())))).resolves.toMatchObject({ statusCode: 401 });
    expect(entries()).toContainEqual(expect.objectContaining({ action: 'session.lock', subject: accountScope(CLAIM.name) }));
  });

  test('the trail says which half of the sign-in was refused, which the answer never does', async () => {
    await owing();
    await signingIn();
    expect(entries()[0]).toMatchObject({
      actor: actorFor(ID),
      action: 'session.signIn',
      subject: CLAIM.name,
      outcome: 'refused',
      detail: expect.stringContaining('second factor'),
    });
  });

  test('an enrolment nobody proved is not owed, and never stands between an operator and their account', async () => {
    await totp.enroll(totpContext('req-0f9c2a41'), ID);
    const response = await signingIn();
    expect(response.statusCode).toBe(201);
    expect(entries()).toMatchObject([{ action: 'session.signIn', outcome: 'allowed' }]);
  });
});

describe('too many attempts', () => {
  const lockingOut = async (name = CLAIM.name): Promise<void> => {
    for (let attempt = 0; attempt < ACCOUNT_ATTEMPT_LIMIT; attempt += 1) {
      expect((await failing('not-the-passphrase', name)).statusCode).toBe(401);
    }
  };

  test('the failure that reaches the threshold locks the handle, and the right password is refused too', async () => {
    let reads = 0;
    const counted: AccountStore = {
      ...accounts,
      authenticate: async (context, credentials) => {
        reads += 1;
        return accounts.authenticate(context, credentials);
      },
    };
    app = await serving({ sessions: store, identity: { ...identity, accounts: counted } });
    await lockingOut();
    expect(reads).toBe(ACCOUNT_ATTEMPT_LIMIT);
    const right = await signingIn();
    expect(right.statusCode).toBe(401);
    expect(right.json().error.code).toBe(SIGN_IN_REFUSED);
    // The gate is asked before the credential is read, so a locked handle costs no derivation at all.
    expect(reads).toBe(ACCOUNT_ATTEMPT_LIMIT);
  });

  test('the lock releases when its window is over, and the same password then opens a session', async () => {
    await lockingOut();
    clock += LOCK_MINUTES[0]! * MINUTE + 1000;
    const response = await signingIn();
    expect(response.statusCode).toBe(201);
  });

  test('a handle nobody holds locks exactly like one somebody does, and locks nothing else', async () => {
    await lockingOut('nobody');
    const gate = attemptContext('req-2b3c4d5e');
    expect(await attempts.locked(gate, accountScope('nobody'))).toBe(true);
    expect(await attempts.locked(gate, accountScope(CLAIM.name))).toBe(false);
    expect((await signingIn()).statusCode).toBe(201);
  });

  test('a sign-in that succeeds forgives the failures that came before it', async () => {
    for (let attempt = 0; attempt < ACCOUNT_ATTEMPT_LIMIT - 1; attempt += 1) await failing();
    expect((await signingIn()).statusCode).toBe(201);
    for (let attempt = 0; attempt < ACCOUNT_ATTEMPT_LIMIT - 1; attempt += 1) await failing();
    expect(await attempts.locked(attemptContext('req-3c4d5e6f'), accountScope(CLAIM.name))).toBe(false);
  });

  test('the trail says a handle was locked, which is the one thing the answer does not say', async () => {
    await lockingOut();
    expect(entries().filter((entry) => entry['action'] === 'session.lock')).toMatchObject([
      { actor: 'system', subject: accountScope(CLAIM.name), outcome: 'refused' },
    ]);
  });
});

describe('where a sign-in may come from', () => {
  test('a page on another site cannot sign anyone in', async () => {
    const response = await signingIn(undefined, { origin: 'https://elsewhere.example.invalid' });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(FORBIDDEN);
    expect(sessionRows.size).toBe(0);
  });

  test('a terminal, which sends no origin at all, is not refused for that', async () => {
    const response = await app.inject({
      method: 'POST',
      url: SESSION_PATH,
      headers: { host: HOST, 'x-forwarded-proto': 'https' },
      payload: { name: CLAIM.name, password: CLAIM.password },
    });
    expect(response.statusCode).toBe(201);
  });
});

describe('ending a session', () => {
  test('ends it, clears the cookie, and the identifier that was ended opens nothing afterwards', async () => {
    const session = await signedIn();
    const response = await asking('DELETE', SESSION_PATH, session);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ ended: true });
    expect(response.headers['set-cookie']).toBe(clearedSessionCookie());
    expect((await asking('GET', SESSION_PATH, session)).statusCode).toBe(401);
  });

  test('is behind the guard, so a page on another site cannot sign an operator out', async () => {
    const session = await signedIn();
    const response = await app.inject({
      method: 'DELETE',
      url: SESSION_PATH,
      headers: { host: HOST, origin: 'https://elsewhere.example.invalid', cookie: sessionCookie(session.token, 60) },
    });
    expect(response.statusCode).toBe(403);
    expect((await asking('GET', SESSION_PATH, session)).statusCode).toBe(200);
  });
});

describe('the ticket a socket handshake carries', () => {
  test('is issued to the session that asked for it, and says how long it is worth having', async () => {
    const session = await signedIn();
    const response = await asking('POST', TICKET_PATH, session);
    expect(response.statusCode).toBe(200);
    const { ticket, expiresInSeconds } = response.json().data;
    expect(isOpaqueToken(String(ticket))).toBe(true);
    expect(expiresInSeconds).toBe(TICKET_SECONDS);
    expect(String(ticket)).not.toBe(session.token);
  });

  test('is refused to a request that carries no session, because a ticket is a session speaking', async () => {
    expect((await asking('POST', TICKET_PATH, undefined)).statusCode).toBe(401);
  });
});

describe('a deployment that cannot sign anyone in', () => {
  test('one that keeps no sessions serves the surface and answers every part of it the same way', async () => {
    app = await serving({ sessions: undefined, identity });
    expect((await asking('GET', SESSION_PATH, undefined)).statusCode).toBe(401);
    expect((await asking('DELETE', SESSION_PATH, undefined)).statusCode).toBe(401);
    expect((await asking('POST', TICKET_PATH, undefined)).statusCode).toBe(401);
    const refused = await signingIn();
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error.code).toBe(SIGN_IN_REFUSED);
  });

  test('one that keeps no accounts refuses in the same words, rather than saying it keeps none', async () => {
    app = await serving({ sessions: store, identity: undefined });
    const refused = await signingIn();
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error.code).toBe(SIGN_IN_REFUSED);
  });
});

describe('what recording must never cost', () => {
  const deaf = (over: Partial<Identity>): SessionRoutesOptions => ({
    sessions: store,
    identity: { ...identity, ...over },
  });

  test('a trail that refuses the entry does not undo the sign-in that happened', async () => {
    app = await serving(deaf({ audit: { record: () => Promise.reject(new Error('the trail is unavailable')) } }));
    expect((await signingIn()).statusCode).toBe(201);
    expect((await failing()).statusCode).toBe(401);
  });

  test('a counter that could not be written does not turn an answer into a fault', async () => {
    const broken: AttemptGate = {
      ...attempts,
      failed: () => Promise.reject(new Error('the gate is unavailable')),
      forgiven: () => Promise.reject(new Error('the gate is unavailable')),
    };
    app = await serving(deaf({ attempts: broken }));
    expect((await failing()).statusCode).toBe(401);
    expect((await signingIn()).statusCode).toBe(201);
  });

  test('a gate that cannot say whether a handle is locked is a fault of this server’s, not a refusal', async () => {
    const blind: AttemptGate = {
      ...attempts,
      locked: () => Promise.reject(new Error('mongodb://holydeck:hunter2@records.invalid:27017 is unreachable')),
    };
    app = await serving(deaf({ attempts: blind }));
    const response = await signingIn();
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('hunter2');
  });

  test('a store that failed for some other reason is a defect, and is not answered as a refused sign-in', async () => {
    const broken: AccountStore = {
      ...accounts,
      authenticate: () => Promise.reject(new TypeError('records.invalid is not a function')),
    };
    app = await serving(deaf({ accounts: broken }));
    const response = await signingIn();
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('not a function');
  });
});
