import { actorFor } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { VALIDATION_FAILED } from '@holydeck/contracts/http';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import {
  ISSUER,
  RECOVERY_CODE_COUNT,
  TOTP_PATH,
  TOTP_RECOVERY_PATH,
  TOTP_VERIFICATION_PATH,
} from '@holydeck/contracts/totp';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { accountContext, accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { FORBIDDEN, guardMutations, mutatingRoutesOf } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { codeAt, stepAt } from './otp.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { TOTP_ENROLLED, TOTP_MISSING, TOTP_REFUSED, serveTotpRoutes } from './totp-routes.js';
import { passkeysOn } from './passkeys.js';
import { TotpError, totpContext, totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { Identity } from './onboarding.js';
import type { Document } from './repositories.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { TotpStore } from './totp.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance, InjectOptions } from 'fastify';

const NOW = '2026-09-13T09:30:00.000Z';
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const ID = 'A'.repeat(22);
const CORRELATION = 'req-0f9c2a41';

const CLAIM = { name: 'lucia', displayName: 'Lucia Brandt', password: 'a-long-enough-passphrase' };

let app: FastifyInstance;
let sessions: SessionStore;
let totp: TotpStore;
let trail: FakeDb;
let identity: Identity;
let session: StartedSession;
let clock: number;

const now = (): string => new Date(clock).toISOString();

const entries = (): Document[] => trail.rows.get('audit_events') ?? [];

const actions = (): unknown[] => entries().map((entry) => entry['action']);

const asking = (method: 'POST' | 'DELETE', url: string, payload?: unknown, held = session) =>
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

const enrolling = () => asking('POST', TOTP_PATH);

const proving = (code: string) => asking('POST', TOTP_VERIFICATION_PATH, { code });

const secretOf = async (): Promise<string> => String((await enrolling()).json().data.secret);

/** An account that holds a proved second factor, and the codes proving it handed back once. */
const proved = async (): Promise<{ readonly secret: string; readonly codes: readonly string[] }> => {
  const secret = await secretOf();
  const codes = (await proving(codeAt(secret, stepAt(now())))).json().data.recoveryCodes as string[];
  return { secret, codes };
};

beforeEach(async () => {
  clock = Date.parse(NOW);
  trail = fakeDb();
  sessions = sessionsOn(memorySessions().db, { now });
  totp = totpsOn(memoryTotp().db, { now });
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
    totp,
    passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
  app = Fastify({ logger: false });
  withSafeErrors(app);
  guardMutations(app, { sessions });
  serveTotpRoutes(app, { identity });
  await app.ready();
  session = await sessions.start(sessionContext(CORRELATION), { actor: actorFor(ID), permissions: [] });
});

afterEach(async () => {
  await app.close();
});

describe('enrolling a second factor', () => {
  test('answers the secret once, and the address a phone reads out of a square', async () => {
    const response = await enrolling();
    expect(response.statusCode).toBe(201);
    const { secret, uri } = response.json().data;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/u);
    // Spelled out rather than left to an authenticator's defaults, and labelled with the handle the
    // operator signed in under, because a phone shows the label and not the identifier.
    expect(uri).toBe(
      `otpauth://totp/${ISSUER}:${CLAIM.name}?secret=${secret}&issuer=${ISSUER}&algorithm=SHA1&digits=6&period=30`,
    );
  });

  test('an enrolment nobody proved is replaced by asking again, which is how a lost phone is recovered from', async () => {
    const first = await secretOf();
    const second = await secretOf();
    expect(second).not.toBe(first);
    await expect(proving(codeAt(first, stepAt(now())))).resolves.toMatchObject({ statusCode: 401 });
    await expect(proving(codeAt(second, stepAt(now())))).resolves.toMatchObject({ statusCode: 200 });
  });

  test('enrolling over a factor that is already proved is refused as the disagreement it is', async () => {
    await proved();
    const response = await enrolling();
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(TOTP_ENROLLED);
    // The refusal changes nothing: the factor the operator still holds goes on being the one that proves.
    expect(await totp.satisfied(totpContext(CORRELATION), ID, '000000')).toBe('refused');
  });

  test('the trail records that a factor was enrolled, and never the secret it was enrolled with', async () => {
    const secret = await secretOf();
    expect(actions()).toEqual(['totp.enroll']);
    expect(JSON.stringify(entries())).not.toContain(secret);
  });
});

describe('proving an enrolment', () => {
  test('the code turns it into the account’s second factor, and hands back the codes for the day it is lost', async () => {
    const { codes } = await proved();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    // As drawn, in the alphabet a person reads off a screen and types back. The grouping the contract
    // names a size for is a display aid, and a code is read back with or without it.
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/u);
  });

  test('a code that is not this enrolment’s proves nothing, and says only that', async () => {
    const secret = await secretOf();
    const response = await proving(codeAt(secret, stepAt(now()) + 9));
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe(TOTP_REFUSED);
    expect(actions()).toEqual(['totp.enroll', 'totp.verify']);
    expect(entries()[1]).toMatchObject({ outcome: 'refused' });
  });

  test('proving nothing is a disagreement about state rather than a wrong code', async () => {
    const response = await proving('000000');
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(TOTP_MISSING);
  });

  test('a body that is not a code at all is said plainly, because this caller has already proved who they are', async () => {
    await secretOf();
    const response = await asking('POST', TOTP_VERIFICATION_PATH, { code: 42 });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(response.json().error.fields[0].path).toBe('secondFactor.code');
  });

  test('the recovery codes are handed over once and kept as digests, so this answer is the only place they are', async () => {
    const { codes } = await proved();
    const again = await asking('POST', TOTP_VERIFICATION_PATH, { code: '000000' });
    expect(again.statusCode).toBe(409);
    for (const code of codes) expect(JSON.stringify(again.json())).not.toContain(code);
  });
});

describe('replacing the recovery codes', () => {
  test('answers a fresh set, and every code in the old one stops working', async () => {
    const { codes } = await proved();
    const response = await asking('POST', TOTP_RECOVERY_PATH);
    expect(response.statusCode).toBe(200);
    const replaced = response.json().data.recoveryCodes as string[];
    expect(replaced).toHaveLength(RECOVERY_CODE_COUNT);
    expect(replaced.filter((code) => codes.includes(code))).toEqual([]);
    expect(await totp.satisfied(totpContext(CORRELATION), ID, String(codes[0]))).toBe('refused');
    expect(await totp.satisfied(totpContext(CORRELATION), ID, String(replaced[0]))).toBe('accepted');
  });

  test('asking for codes to a factor nobody proved is the same disagreement about state', async () => {
    await secretOf();
    const response = await asking('POST', TOTP_RECOVERY_PATH);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(TOTP_MISSING);
  });
});

describe('giving up a second factor', () => {
  test('answers whether there was one, and the password it was a second factor to is untouched', async () => {
    await proved();
    const first = await asking('DELETE', TOTP_PATH, { password: CLAIM.password });
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toEqual({ revoked: true });
    const again = await asking('DELETE', TOTP_PATH, { password: CLAIM.password });
    expect(again.json().data).toEqual({ revoked: false });
    const account = await identity.accounts.authenticate(accountContext(CORRELATION), {
      name: CLAIM.name,
      password: CLAIM.password,
    });
    expect(account).toMatchObject({ id: ID });
    expect(await totp.satisfied(totpContext(CORRELATION), ID, '000000')).toBe('none');
  });

  test('the trail records every turn a second factor took, under the account it belonged to', async () => {
    await proved();
    await asking('POST', TOTP_RECOVERY_PATH);
    await asking('DELETE', TOTP_PATH, { password: CLAIM.password });
    expect(actions()).toEqual(['totp.enroll', 'totp.verify', 'totp.regenerate', 'totp.revoke']);
    for (const entry of entries()) expect(entry['actor']).toBe(actorFor(ID));
  });
});

describe('who may ask any of it', () => {
  test('every route here changes something, and so every one is behind the guard', async () => {
    expect(mutatingRoutesOf(app)).toEqual([
      { method: 'POST', url: TOTP_PATH },
      { method: 'POST', url: TOTP_VERIFICATION_PATH },
      { method: 'POST', url: TOTP_RECOVERY_PATH },
      { method: 'DELETE', url: TOTP_PATH },
    ]);
    const open = await app.inject({ method: 'POST', url: TOTP_PATH, headers: { host: HOST, origin: ORIGIN } });
    expect(open.statusCode).toBe(401);
  });

  test('a session no account holds reaches none of them, because there is nobody for a factor to belong to', async () => {
    const service = await sessions.start(sessionContext(CORRELATION), { actor: 'system', permissions: [] });
    for (const [method, url] of [
      ['POST', TOTP_PATH],
      ['POST', TOTP_VERIFICATION_PATH],
      ['POST', TOTP_RECOVERY_PATH],
      ['DELETE', TOTP_PATH],
    ] as const) {
      const response = await asking(method, url, { code: '000000' }, service);
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe(FORBIDDEN);
    }
  });
});

describe('what this surface refuses to answer at all', () => {
  const serving = async (bag: Identity | undefined): Promise<FastifyInstance> => {
    const built = Fastify({ logger: false });
    withSafeErrors(built);
    guardMutations(built, { sessions });
    serveTotpRoutes(built, { identity: bag });
    await built.ready();
    return built;
  };

  test('a deployment that keeps no accounts serves every path, and answers not-found from each', async () => {
    await app.close();
    app = await serving(undefined);
    for (const [method, url] of [
      ['POST', TOTP_PATH],
      ['POST', TOTP_VERIFICATION_PATH],
      ['POST', TOTP_RECOVERY_PATH],
      ['DELETE', TOTP_PATH],
    ] as const) {
      const response = await asking(method, url, { code: '000000' });
      expect(response.statusCode).toBe(404);
    }
  });

  test('a session for an account this server no longer holds enrols nothing', async () => {
    const stale = await sessions.start(sessionContext(CORRELATION), {
      actor: actorFor('B'.repeat(22)),
      permissions: [],
    });
    const response = await asking('POST', TOTP_PATH, undefined, stale);
    expect(response.statusCode).toBe(403);
  });

  test('a store that refused for any other reason is this server’s defect, not a second factor’s answer', async () => {
    const defects = [new TotpError('permission', 'totp: the actor may not write a second factor'), new TypeError('x')];
    for (const defect of defects) {
      await app.close();
      app = await serving({
        ...identity,
        totp: {
          ...totp,
          enroll: () => Promise.reject(defect),
          verify: () => Promise.reject(defect),
          regenerate: () => Promise.reject(defect),
        },
      });
      for (const [method, url] of [
        ['POST', TOTP_PATH],
        ['POST', TOTP_VERIFICATION_PATH],
        ['POST', TOTP_RECOVERY_PATH],
      ] as const) {
        const response = await asking(method, url, { code: '000000' });
        expect(response.statusCode).toBe(500);
      }
    }
  });

  test('a trail that refuses an entry does not cost the operator the factor they enrolled', async () => {
    await app.close();
    app = await serving({
      ...identity,
      audit: {
        record: () => Promise.reject(new Error('the trail is unavailable')),
        list: () => Promise.reject(new Error('the trail is unavailable')),
      },
    });
    const response = await asking('POST', TOTP_PATH);
    expect(response.statusCode).toBe(201);
  });
});


describe('password confirmation before credential removal', () => {
  test.each([undefined, {}, { password: 'wrong' }, { password: 12 }, { password: 'x'.repeat(1025) }])(
    'refuses missing or invalid confirmation (%j) and preserves the credential', async (body) => {
      await proved();
      const response = await asking('DELETE', TOTP_PATH, body);
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('auth.sign_in_refused');
      expect(await totp.satisfied(totpContext(CORRELATION), ID, 'wrong')).toBe('refused');
      expect(entries().at(-1)).toMatchObject({ action: 'totp.revoke', outcome: 'refused', actor: actorFor(ID) });
      expect(JSON.stringify(entries())).not.toContain('wrong');
    },
  );

  test('locks repeated guesses even when the next password is correct', async () => {
    await proved();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await asking('DELETE', TOTP_PATH, { password: 'wrong' });
    }
    const response = await asking('DELETE', TOTP_PATH, { password: CLAIM.password });
    expect(response.statusCode).toBe(401);
    expect(await totp.satisfied(totpContext(CORRELATION), ID, 'wrong')).toBe('refused');
  });
});
