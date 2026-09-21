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
import {
  ACCOUNT_ATTEMPT_LIMIT,
  ADDRESS_ATTEMPT_LIMIT,
  LOCK_MINUTES,
  accountScope,
  addressScope,
  attemptContext,
  attemptsOn,
} from './attempts.js';
import { auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { FORBIDDEN, guardMutations, mutatingRoutesOf } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { codeAt, stepAt } from './otp.js';
import { passkeyContext, passkeysOn } from './passkeys.js';
import { ACCOUNTS_MANAGE, LAYOUTS_MANAGE, MEDIA_MANAGE, PRESENTATION_CONTROL, SETTINGS_MANAGE } from './roles.js';
import { SIGN_IN_REFUSED, serveSessionRoutes } from './session-routes.js';
import { SessionError, sessionContext, sessionsOn, tokenDigest } from './sessions.js';
import { totpContext, totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';
import { webauthnDevice } from '../test/helpers/webauthn-device.js';

import type { AccountStore } from './accounts.js';
import type { AttemptGate } from './attempts.js';
import type { Identity } from './onboarding.js';
import type { SessionRoutesOptions } from './session-routes.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { TotpStore } from './totp.js';
import type { Document } from './repositories.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { AuthenticateOptions, WebAuthnDevice } from '../test/helpers/webauthn-device.js';
import type { FastifyInstance, InjectOptions } from 'fastify';

const NOW = '2026-09-13T09:30:00.000Z';
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const ID = 'A'.repeat(22);
/** The address an injected request arrives from when it names none, which is what the gate scopes by. */
const CALLER = '127.0.0.1';

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
  enforceAuthorization(built, { sessions: options.sessions, identity: undefined });
  serveSessionRoutes(built, options);
  await built.ready();
  return built;
};

const signedIn = async (): Promise<StartedSession> =>
  store.start(sessionContext('req-0f9c2a41'), { actor: 'account:7f3a', permissions: ['services.read'] });

const asking = (
  method: 'GET' | 'DELETE' | 'PATCH' | 'POST',
  url: string,
  session: StartedSession | undefined,
  payload?: unknown,
) =>
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
    ...(payload === undefined ? {} : { payload: payload as InjectOptions['payload'] }),
  });

/** The identifier a slot for the given actor was assigned inside the container the token names. */
const slotIdOf = (token: string, actor: string): string => {
  const stored = sessionRows.get(tokenDigest(token)) as Document;
  const slot = (stored['slots'] as Document[]).find((candidate) => candidate['actor'] === actor) as Document;
  return slot['slotId'] as string;
};

/** Two slots in one container: a Control-permissioned one, and a Member-permissioned one joined onto it. */
const joined = async (): Promise<{ readonly control: StartedSession; readonly member: StartedSession }> => {
  const control = await store.start(sessionContext('req-0f9c2a41'), {
    actor: 'account:c0e7',
    permissions: [PRESENTATION_CONTROL],
  });
  const member = await store.start(
    sessionContext('req-0f9c2a41'),
    { actor: 'account:9b12', permissions: ['services.read'] },
    control.token,
  );
  return { control: { ...control, token: member.token }, member };
};

const signingIn = (
  payload: unknown = { name: CLAIM.name, password: CLAIM.password },
  headers: Record<string, string | undefined> = {},
  remoteAddress?: string,
) =>
  app.inject({
    method: 'POST',
    url: SESSION_PATH,
    ...(remoteAddress === undefined ? {} : { remoteAddress }),
    headers: {
      [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
      host: HOST,
      'x-forwarded-proto': 'https',
      origin: ORIGIN,
      ...headers,
    } as Record<string, string>,
    payload: payload as InjectOptions['payload'],
  });

const failing = (password = 'not-the-passphrase', name = CLAIM.name, remoteAddress?: string) =>
  signingIn({ name, password }, {}, remoteAddress);

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

/** A key already registered to the claimed account, the way a prior sign-in would have left one. */
const registered = async (options?: { readonly counter?: number }): Promise<WebAuthnDevice> => {
  const device = webauthnDevice({ rpId: HOST, origin: ORIGIN });
  await identity.passkeys.register(passkeyContext('req-passkey-fixture'), ID, {
    id: device.credentialId,
    name: 'a registered key',
    publicKey: Buffer.from(device.publicKey).toString('base64url'),
    counter: options?.counter ?? 0,
    transports: ['internal'],
    synced: true,
  });
  return device;
};

/** Draws the challenge a browser would get back from asking to sign in with a passkey. */
const passkeyChallenge = async (): Promise<string> => {
  const response = await signingIn({ passkey: { step: 'challenge' } });
  expect(response.statusCode).toBe(200);
  return String(response.json().data.passkey.challenge);
};

const signingInWithPasskey = (device: WebAuthnDevice, challenge: string, options?: AuthenticateOptions) => {
  const produced = device.authenticate(challenge, options);
  return signingIn({
    passkey: {
      step: 'assertion',
      assertion: {
        id: produced.id,
        rawId: produced.rawId,
        type: 'public-key',
        response: {
          clientDataJSON: produced.response.clientDataJSON,
          authenticatorData: produced.response.authenticatorData,
          signature: produced.response.signature,
          ...(produced.response.userHandle === undefined ? {} : { userHandle: produced.response.userHandle }),
        },
      },
    },
  });
};

beforeEach(async () => {
  clock = Date.parse(NOW);
  trail = fakeDb();
  const sessions = memorySessions();
  sessionRows = sessions.rows;
  store = sessionsOn(sessions.db, { now });
  let accountNumber = 0;
  accounts = accountsOn(memoryAccounts().db, {
    now,
    newId: () => String.fromCharCode(65 + accountNumber++).repeat(22),
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
    passkeys: passkeysOn(memoryPasskeys().db, { now }),
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
    expect(response.json().data).toMatchObject(session.record);
    // The container this session belongs to holds one slot so far: itself.
    expect(response.json().data.slots).toEqual([{ slotId: expect.any(String), actor: session.record.actor }]);
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
      { method: 'PATCH', url: SESSION_PATH },
      { method: 'POST', url: TICKET_PATH },
    ]);
  });
});

describe('adversarial: session hijack', () => {
  test('a digest read from the store cannot open the session it was computed from', async () => {
    const session = await signedIn();
    // An attacker who reached the database — a breached backup, a leaked log line — holds only the
    // digest sessions.ts stores as `_id`, never the bearer token a browser actually carries. Presenting
    // that digest as though it were the token is refused exactly as any other unknown token is: hashing
    // it again never lands on the `_id` a real token's digest would.
    const stolen = tokenDigest(session.token);
    const response = await asking('GET', SESSION_PATH, { ...session, token: stolen });
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBe(clearedSessionCookie());

    // Nothing about the real session was disturbed by the attempt: the token it was actually issued
    // still opens it.
    expect((await asking('GET', SESSION_PATH, session)).statusCode).toBe(200);
  });
});

describe('signing in', () => {
  test('a handle and the password it was claimed with open a session, given as a cookie', async () => {
    const response = await signingIn();
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      actor: actorFor(ID),
      rotation: 'authentication',
      // Granted from the account this session was opened for: a founder is Admin by role.
      permissions: [ACCOUNTS_MANAGE, SETTINGS_MANAGE, LAYOUTS_MANAGE, MEDIA_MANAGE],
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

describe('signing in while a session is already open in this browser', () => {
  test('audits a genuine join even though authentication rotates the container token', async () => {
    const first = await signedIn();
    const cookie = sessionCookie(first.token, 60);
    const response = await app.inject({
      method: 'POST',
      url: SESSION_PATH,
      headers: { host: HOST, 'x-forwarded-proto': 'https', origin: ORIGIN, cookie },
      payload: { name: CLAIM.name, password: CLAIM.password },
    });
    expect(response.statusCode).toBe(201);
    const token = tokenIn(response.headers['set-cookie']);
    expect(token).not.toBe(first.token);
    expect(await store.slots(sessionContext('req-join-audit'), token)).toHaveLength(2);
    await expect(store.read(sessionContext('req-join-audit'), first.token)).rejects.toMatchObject({ kind: 'unknown' });
    expect(entries()).toContainEqual(
      expect.objectContaining({ action: 'session.slot.add', subject: actorFor(ID), outcome: 'allowed' }),
    );
  });
});

describe('signing in with a passkey', () => {
  test('a registered key opens a session, exactly as a password does', async () => {
    const device = await registered();
    const challenge = await passkeyChallenge();
    const response = await signingInWithPasskey(device, challenge);
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      actor: actorFor(ID),
      rotation: 'authentication',
      permissions: [ACCOUNTS_MANAGE, SETTINGS_MANAGE, LAYOUTS_MANAGE, MEDIA_MANAGE],
    });
    const cookie = String(response.headers['set-cookie']);
    expect(isOpaqueToken(tokenIn(cookie))).toBe(true);
  });

  test('the trail records the sign-in under the key, and when it was used is kept', async () => {
    const device = await registered();
    const challenge = await passkeyChallenge();
    await signingInWithPasskey(device, challenge);
    expect(entries()).toContainEqual(
      expect.objectContaining({
        actor: actorFor(ID),
        action: 'passkey.use',
        subject: device.credentialId,
        outcome: 'allowed',
      }),
    );
    const stored = await identity.passkeys.find(passkeyContext('req-passkey-check'), device.credentialId);
    expect(stored?.lastUsedAt).toBe(NOW);
  });

  test('a counter that has not moved past what was last reported is refused, and opens nothing', async () => {
    const device = await registered({ counter: 5 });
    const first = await passkeyChallenge();
    await expect(signingInWithPasskey(device, first, { signCount: 6 })).resolves.toMatchObject({ statusCode: 201 });
    const second = await passkeyChallenge();
    const response = await signingInWithPasskey(device, second, { signCount: 3 });
    expect(response.statusCode).toBe(401);
    const stored = await identity.passkeys.find(passkeyContext('req-passkey-counter'), device.credentialId);
    expect(stored?.counter).toBe(6);
  });

  test('a key this deployment has revoked answers the same refusal a wrong password does', async () => {
    const device = await registered();
    await identity.passkeys.revoke(passkeyContext('req-passkey-revoke'), ID, device.credentialId);
    const challenge = await passkeyChallenge();
    const response = await signingInWithPasskey(device, challenge);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe(SIGN_IN_REFUSED);
  });

  test('a credential this deployment never registered is refused the same way', async () => {
    const stranger = webauthnDevice({ rpId: HOST, origin: ORIGIN });
    const challenge = await passkeyChallenge();
    const response = await signingInWithPasskey(stranger, challenge);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe(SIGN_IN_REFUSED);
  });

  test('a signature that does not check out is refused, and opens nothing', async () => {
    const device = await registered();
    const challenge = await passkeyChallenge();
    const response = await signingInWithPasskey(device, challenge, { wrongSignature: true });
    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(sessionRows.size).toBe(0);
  });

  test('a run of bad signatures locks the handle, exactly as a run of bad passwords does', async () => {
    const device = await registered();
    for (let attempt = 0; attempt < ACCOUNT_ATTEMPT_LIMIT; attempt += 1) {
      const challenge = await passkeyChallenge();
      await signingInWithPasskey(device, challenge, { wrongSignature: true });
    }
    expect(entries()).toContainEqual(expect.objectContaining({ action: 'session.lock', subject: accountScope(CLAIM.name) }));
  });

  test('a challenge answered twice is spent the first time and refused the second', async () => {
    const device = await registered();
    const challenge = await passkeyChallenge();
    await expect(signingInWithPasskey(device, challenge)).resolves.toMatchObject({ statusCode: 201 });
    await expect(signingInWithPasskey(device, challenge)).resolves.toMatchObject({ statusCode: 401 });
  });

  test('a challenge drawn for a registration is not answered as one drawn for a sign-in', async () => {
    const device = await registered();
    const drawnForRegistration = await identity.passkeys.challenge(
      passkeyContext('req-passkey-reg-challenge'),
      'registration',
      ID,
    );
    const response = await signingInWithPasskey(device, drawnForRegistration);
    expect(response.statusCode).toBe(401);
  });

  test('client data with no readable challenge is refused, not read as any particular one', async () => {
    const stranger = webauthnDevice({ rpId: HOST, origin: ORIGIN });
    const garbled = Buffer.from(JSON.stringify({ type: 'webauthn.get' }), 'utf8').toString('base64url');
    const produced = stranger.authenticate('unused-challenge');
    const response = await signingIn({
      passkey: {
        step: 'assertion',
        assertion: {
          id: produced.id,
          rawId: produced.rawId,
          type: 'public-key',
          response: {
            clientDataJSON: garbled,
            authenticatorData: produced.response.authenticatorData,
            signature: produced.response.signature,
          },
        },
      },
    });
    expect(response.statusCode).toBe(401);
    expect(entries()).toContainEqual(
      expect.objectContaining({ action: 'passkey.use', outcome: 'refused', detail: 'no readable challenge' }),
    );
  });

  test('a body that names the step but nothing else is refused, not answered as a validation problem', async () => {
    const response = await signingIn({ passkey: {} });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe(SIGN_IN_REFUSED);
    expect(response.body).not.toContain(VALIDATION_FAILED);
  });

  test('a key whose account this deployment no longer holds is refused', async () => {
    const orphan = webauthnDevice({ rpId: HOST, origin: ORIGIN });
    await identity.passkeys.register(passkeyContext('req-passkey-orphan'), 'B'.repeat(22), {
      id: orphan.credentialId,
      name: 'an orphaned key',
      publicKey: Buffer.from(orphan.publicKey).toString('base64url'),
      counter: 0,
      transports: ['internal'],
      synced: true,
    });
    const challenge = await passkeyChallenge();
    const response = await signingInWithPasskey(orphan, challenge);
    expect(response.statusCode).toBe(401);
  });

  test('a locked account refuses even the right key, exactly as it refuses the right password', async () => {
    const device = await registered();
    for (let attempt = 0; attempt < ACCOUNT_ATTEMPT_LIMIT; attempt += 1) await failing();
    const challenge = await passkeyChallenge();
    const response = await signingInWithPasskey(device, challenge);
    expect(response.statusCode).toBe(401);
    expect(sessionRows.size).toBe(0);
  });

  test('an account this deployment has disabled is refused its key, exactly as it is refused its password', async () => {
    const device = await registered();
    await accounts.create(accountContext('req-passkey-disabled'), { ...CLAIM, name: 'other-admin', role: 'admin' });
    await accounts.disable(accountContext('req-passkey-disabled'), ID);
    const withPassword = await signingIn();
    expect(withPassword.statusCode).toBe(401);
    const challenge = await passkeyChallenge();
    const response = await signingInWithPasskey(device, challenge);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe(SIGN_IN_REFUSED);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(sessionRows.size).toBe(0);
  });

  test('an account this deployment has not disabled still opens a session with its key', async () => {
    const device = await registered();
    await accounts.create(accountContext('req-passkey-disabled'), { ...CLAIM, name: 'other-admin', role: 'admin' });
    await accounts.disable(accountContext('req-passkey-disabled'), ID);
    await accounts.restore(accountContext('req-passkey-restored'), ID);
    const challenge = await passkeyChallenge();
    const response = await signingInWithPasskey(device, challenge);
    expect(response.statusCode).toBe(201);
    expect(sessionRows.size).toBe(1);
  });

  test('a sign-in that succeeds forgives the failures that came before it, the gate a password shares', async () => {
    const device = await registered();
    for (let attempt = 0; attempt < ACCOUNT_ATTEMPT_LIMIT - 1; attempt += 1) await failing();
    const challenge = await passkeyChallenge();
    await expect(signingInWithPasskey(device, challenge)).resolves.toMatchObject({ statusCode: 201 });
    expect(await attempts.locked(attemptContext('req-passkey-forgiven'), accountScope(CLAIM.name))).toBe(false);
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

  test('the handle gate is asked on its own terms: a handle locks without the address it came from locking', async () => {
    await lockingOut();
    const gate = attemptContext('req-4d5e6f70');
    expect(await attempts.locked(gate, accountScope(CLAIM.name))).toBe(true);
    expect(await attempts.locked(gate, addressScope(CALLER))).toBe(false);
  });
});

describe('too many attempts from one address', () => {
  const ELSEWHERE = '203.0.113.7';

  /** A run of failures spread over as many handles, which is what no per-handle gate can ever see. */
  const guessing = async (handles: number, address?: string): Promise<void> => {
    for (let attempt = 0; attempt < handles; attempt += 1) {
      expect((await failing('not-the-passphrase', `nobody-${attempt}`, address)).statusCode).toBe(401);
    }
  };

  test('a caller working through a list of handles is locked out, though no single handle ever was', async () => {
    await guessing(ADDRESS_ATTEMPT_LIMIT);
    const gate = attemptContext('req-4d5e6f70');
    expect(await attempts.locked(gate, addressScope(CALLER))).toBe(true);
    expect(await attempts.locked(gate, accountScope('nobody-0'))).toBe(false);
    const right = await signingIn();
    expect(right.statusCode).toBe(401);
    expect(right.json().error.code).toBe(SIGN_IN_REFUSED);
    expect(sessionRows.size).toBe(0);
  });

  test('a caller that stays under the threshold is held against nothing, and signs in as normal', async () => {
    await guessing(ADDRESS_ATTEMPT_LIMIT - 1);
    expect(await attempts.locked(attemptContext('req-4d5e6f70'), addressScope(CALLER))).toBe(false);
    expect((await signingIn()).statusCode).toBe(201);
  });

  test('one address guessing locks nobody else, which is what keeps the gate from being a weapon', async () => {
    await guessing(ADDRESS_ATTEMPT_LIMIT, ELSEWHERE);
    expect(await attempts.locked(attemptContext('req-4d5e6f70'), addressScope(ELSEWHERE))).toBe(true);
    expect((await signingIn(undefined, {}, CALLER)).statusCode).toBe(201);
  });

  test('the lock releases when its window is over, and the same caller is served again', async () => {
    await guessing(ADDRESS_ATTEMPT_LIMIT);
    expect((await signingIn()).statusCode).toBe(401);
    clock += LOCK_MINUTES[0]! * MINUTE + 1000;
    expect((await signingIn()).statusCode).toBe(201);
  });

  test('a locked address is refused a key as well as a password, before the key is read at all', async () => {
    const device = await registered();
    const challenge = await passkeyChallenge();
    await guessing(ADDRESS_ATTEMPT_LIMIT);
    const response = await signingInWithPasskey(device, challenge);
    expect(response.statusCode).toBe(401);
    expect(sessionRows.size).toBe(0);
  });

  test('a locked address is not even drawn a fresh challenge to answer', async () => {
    await guessing(ADDRESS_ATTEMPT_LIMIT);
    const response = await signingIn({ passkey: { step: 'challenge' } });
    expect(response.statusCode).toBe(401);
  });

  test('a run of keys this deployment never registered locks the address the run came from', async () => {
    const stranger = webauthnDevice({ rpId: HOST, origin: ORIGIN });
    for (let attempt = 0; attempt < ADDRESS_ATTEMPT_LIMIT; attempt += 1) {
      const challenge = await passkeyChallenge();
      expect((await signingInWithPasskey(stranger, challenge)).statusCode).toBe(401);
    }
    expect(await attempts.locked(attemptContext('req-4d5e6f70'), addressScope(CALLER))).toBe(true);
  });

  test('one sign-in does not buy a fresh run of guesses, because the address keeps what it earned', async () => {
    await guessing(ADDRESS_ATTEMPT_LIMIT - 1);
    expect((await signingIn()).statusCode).toBe(201);
    expect((await failing('not-the-passphrase', 'nobody-last')).statusCode).toBe(401);
    expect(await attempts.locked(attemptContext('req-4d5e6f70'), addressScope(CALLER))).toBe(true);
  });

  test('the trail says an address was locked, under a scope that is not the address itself', async () => {
    await guessing(ADDRESS_ATTEMPT_LIMIT);
    const locks = entries().filter((entry) => entry['action'] === 'session.lock');
    expect(locks).toMatchObject([{ actor: 'system', subject: addressScope(CALLER), outcome: 'refused' }]);
    expect(JSON.stringify(entries())).not.toContain(CALLER);
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

describe('switching between the slots a container holds', () => {
  test('moves the pointer, sets no cookie either way, and the next request answers as the new slot', async () => {
    const { control, member } = await joined();
    const controlId = slotIdOf(control.token, control.record.actor);
    const response = await asking('PATCH', SESSION_PATH, member, { active: controlId });
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.json().data).toMatchObject({ actor: control.record.actor });
    const after = await asking('GET', SESSION_PATH, member);
    expect(after.json().data).toMatchObject({ actor: control.record.actor });
  });

  test('an identifier naming no slot in this container is refused, and the active slot stays what it was', async () => {
    const { member } = await joined();
    const response = await asking('PATCH', SESSION_PATH, member, { active: 'not-a-real-slot' });
    expect(response.statusCode).toBe(403);
    const after = await asking('GET', SESSION_PATH, member);
    expect(after.json().data).toMatchObject({ actor: member.record.actor });
  });

  test('is behind the guard, so a page on another site cannot switch an operator’s slot', async () => {
    const { control, member } = await joined();
    const controlId = slotIdOf(control.token, control.record.actor);
    const response = await app.inject({
      method: 'PATCH',
      url: SESSION_PATH,
      headers: { host: HOST, origin: 'https://elsewhere.example.invalid', cookie: sessionCookie(member.token, 60) },
      payload: { active: controlId },
    });
    expect(response.statusCode).toBe(403);
  });

  test('is refused to a request that carries no session', async () => {
    expect((await asking('PATCH', SESSION_PATH, undefined, { active: 'anything' })).statusCode).toBe(401);
  });

  test('a body with no active identifier at all is refused the same way an unknown one is', async () => {
    const { member } = await joined();
    expect((await asking('PATCH', SESSION_PATH, member, {})).statusCode).toBe(403);
  });

  test('no body at all is refused the same way, rather than read as any particular slot', async () => {
    const { member } = await joined();
    expect((await asking('PATCH', SESSION_PATH, member)).statusCode).toBe(403);
  });

  test('a refusal for a reason other than an unknown slot is answered the way any other refusal is', async () => {
    const session = await signedIn();
    const broken: SessionStore = { ...store, activate: () => Promise.reject(new SessionError('expired', 'gone')) };
    app = await serving({ sessions: broken, identity });
    const response = await asking('PATCH', SESSION_PATH, session, { active: 'anything' });
    expect(response.statusCode).toBe(401);
  });

  test('the trail records which slot a switch asked for, allowed or refused', async () => {
    const { control, member } = await joined();
    const controlId = slotIdOf(control.token, control.record.actor);
    await asking('PATCH', SESSION_PATH, member, { active: controlId });
    // The active slot is `control` now, so the second, invalid switch is proven with `control`'s own
    // token — `member`'s CSRF token would be refused by the guard before the route is ever reached.
    await asking('PATCH', SESSION_PATH, control, { active: 'not-a-real-slot' });
    expect(entries()).toMatchObject([
      { action: 'session.slot.switch', subject: control.record.actor, outcome: 'allowed' },
      { action: 'session.slot.switch', subject: 'not-a-real-slot', outcome: 'refused' },
    ]);
  });
});

describe('security fixture: account-switching.v1', () => {
  // Two of these six scenarios name a surface this release does not yet have: a drafts editor and a
  // presentation output window are both later work. Each is proved here at the mechanism level instead —
  // against a purpose-built route gated the same way a real one would be — because the thing under test
  // is the authorization boundary between slots, not the surface a later release will hang off it.

  test('issue a Control presentation command while the Member slot is active', async () => {
    const probePath = '/api/v1/test/control-only';
    const built = Fastify({ logger: false });
    withSafeErrors(built);
    guardMutations(built, { sessions: store });
    enforceAuthorization(built, { sessions: store, identity: undefined });
    serveSessionRoutes(built, { sessions: store, identity });
    built.get(probePath, { config: { need: { kind: 'permission', need: PRESENTATION_CONTROL } } }, async () => ({
      issued: true,
    }));
    await built.ready();
    app = built;
    const { member } = await joined();
    const response = await asking('GET', probePath, member);
    expect(response.statusCode).toBe(403);
  });

  test('read the Editor drafts from the Member slot', async () => {
    const probePath = '/api/v1/test/drafts-only';
    const built = Fastify({ logger: false });
    withSafeErrors(built);
    guardMutations(built, { sessions: store });
    enforceAuthorization(built, { sessions: store, identity: undefined });
    serveSessionRoutes(built, { sessions: store, identity });
    built.get(probePath, { config: { need: { kind: 'permission', need: 'drafts.read' } } }, async () => ({
      drafts: [],
    }));
    await built.ready();
    app = built;
    const control = await store.start(sessionContext('req-0f9c2a41'), { actor: 'account:1e2f', permissions: ['drafts.read'] });
    const member = await store.start(
      sessionContext('req-0f9c2a41'),
      { actor: 'account:9b12', permissions: ['services.read'] },
      control.token,
    );
    const response = await asking('GET', probePath, member);
    expect(response.statusCode).toBe(403);
  });

  test('replay the Editor CSRF token from the Member slot', async () => {
    const { control, member } = await joined();
    const response = await app.inject({
      method: 'DELETE',
      url: SESSION_PATH,
      headers: {
        [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
        host: HOST,
        'x-forwarded-proto': 'https',
        origin: ORIGIN,
        cookie: sessionCookie(member.token, 60),
        [CSRF_HEADER]: control.record.csrf,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(FORBIDDEN);
  });

  test('switch back mid-run and resume the run', async () => {
    const { control, member } = await joined();
    const controlId = slotIdOf(control.token, control.record.actor);
    const memberId = slotIdOf(control.token, member.record.actor);
    // Control is running something — it holds the ticket for the run — before anyone switches away.
    await store.activate(sessionContext('req-0f9c2a41'), control.token, controlId);
    const ticket = await store.issueTicket(sessionContext('req-0f9c2a41'), control.token);
    await asking('PATCH', SESSION_PATH, control, { active: memberId });
    const response = await asking('PATCH', SESSION_PATH, member, { active: controlId });
    expect(response.statusCode).toBe(200);
    // Resolving the ticket after switching away and back proves the run it stands for was never disturbed.
    const resumed = await store.redeemTicket(sessionContext('req-0f9c2a41'), control.token, ticket);
    expect(resumed.actor).toBe(control.record.actor);
  });

  test('present the Editor session cookie with the Member slot selected', async () => {
    const { control, member } = await joined();
    const controlId = slotIdOf(control.token, control.record.actor);
    await store.activate(sessionContext('req-0f9c2a41'), control.token, controlId);
    // A claim of "the Member slot is selected" sent in the one place a client could try to put it — there
    // is no such field this route reads, since the cookie names a container and never a slot.
    const response = await app.inject({
      method: 'GET',
      url: SESSION_PATH,
      headers: {
        [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
        host: HOST,
        'x-forwarded-proto': 'https',
        origin: ORIGIN,
        cookie: sessionCookie(control.token, 60),
        'x-claimed-active-slot': slotIdOf(control.token, member.record.actor),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ actor: control.record.actor });
  });

  test('open an output window from the Member slot claiming Control', async () => {
    const { member } = await joined();
    const response = await asking('POST', TICKET_PATH, member);
    expect(response.statusCode).toBe(200);
    const { ticket } = response.json().data as { readonly ticket: string };
    // Redemption has no HTTP surface of its own — it happens inside the WebSocket handshake a later
    // release wires up — so it is proved directly against the store, the same call that handshake makes.
    const resolved = await store.redeemTicket(sessionContext('req-0f9c2a41'), member.token, ticket);
    expect(resolved.actor).toBe(member.record.actor);
    expect(resolved.permissions).not.toContain(PRESENTATION_CONTROL);
  });
});

describe('a deployment that cannot sign anyone in', () => {
  test('one that keeps no sessions serves the surface and answers every part of it the same way', async () => {
    app = await serving({ sessions: undefined, identity });
    expect((await asking('GET', SESSION_PATH, undefined)).statusCode).toBe(401);
    expect((await asking('DELETE', SESSION_PATH, undefined)).statusCode).toBe(401);
    expect((await asking('PATCH', SESSION_PATH, undefined, { active: 'anything' })).statusCode).toBe(401);
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

  test('one that keeps no accounts still switches a slot, with nothing to trail it in', async () => {
    app = await serving({ sessions: store, identity: undefined });
    const { control, member } = await joined();
    const controlId = slotIdOf(control.token, control.record.actor);
    const response = await asking('PATCH', SESSION_PATH, member, { active: controlId });
    expect(response.statusCode).toBe(200);
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

  test('a trail that refuses the entry does not undo the slot switch that happened', async () => {
    app = await serving(deaf({ audit: { record: () => Promise.reject(new Error('the trail is unavailable')) } }));
    const { control, member } = await joined();
    const controlId = slotIdOf(control.token, control.record.actor);
    expect((await asking('PATCH', SESSION_PATH, member, { active: controlId })).statusCode).toBe(200);
    const after = await asking('GET', SESSION_PATH, member);
    expect(after.json().data).toMatchObject({ actor: control.record.actor });
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
