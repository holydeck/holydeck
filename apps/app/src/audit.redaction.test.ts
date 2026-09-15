// Regression for what `audit.ts`'s own comment promises: nothing here is ever handed a secret. That is
// not a mechanism this module enforces — there is no redactor in the write path — so the only way to
// prove it holds is to exercise the surfaces the plan names as secret-bearing through their real routes,
// each with a marker distinctive enough that finding it anywhere in the trail could only mean it leaked.

import { actorFor } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { CSRF_HEADER, SESSION_PATH, sessionCookie } from '@holydeck/contracts/sessions';
import { TOTP_PATH, TOTP_VERIFICATION_PATH } from '@holydeck/contracts/totp';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { accountContext, accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { guardMutations } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { codeAt, stepAt } from './otp.js';
import { passkeyContext, passkeysOn } from './passkeys.js';
import { SETTINGS_MANAGE } from './roles.js';
import { serveSessionRoutes } from './session-routes.js';
import { settingsAdminOn } from './settings-admin.js';
import { SETTINGS_PATH, serveSettingsRoutes } from './settings-routes.js';
import { CANONICAL_SETTINGS_PATH, loadSettings } from './settings.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { serveTotpRoutes } from './totp-routes.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { fakeSettingsIO } from '../test/helpers/settings-io.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';
import { webauthnDevice } from '../test/helpers/webauthn-device.js';

import type { Identity } from './onboarding.js';
import type { Document } from './repositories.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { WebAuthnDevice } from '../test/helpers/webauthn-device.js';
import type { FastifyInstance } from 'fastify';

const NOW = '2026-09-13T09:30:00.000Z';
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const ID = 'A'.repeat(22);
const CORRELATION = 'req-0f9c2a41';
const CLAIM = { name: 'lucia', displayName: 'Lucia Brandt', password: 'a-long-enough-passphrase' };

const now = (): string => NOW;

const headersFor = (session?: StartedSession) => ({
  [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
  host: HOST,
  'x-forwarded-proto': 'https',
  origin: ORIGIN,
  ...(session === undefined ? {} : { cookie: sessionCookie(session.token, 60), [CSRF_HEADER]: session.record.csrf }),
});

let trail: FakeDb;
let identity: Identity;

const entries = (): Document[] => trail.rows.get('audit_events') ?? [];

/** Every entry the trail holds, flattened so a secret can be searched for as a plain substring. */
const trailText = (): string => JSON.stringify(entries());

beforeEach(() => {
  trail = fakeDb();
  identity = {
    accounts: accountsOn(memoryAccounts().db, {
      now,
      newId: () => ID,
      hash: async (password) => `test-hash:${password}`,
      verify: async (password, stored) => stored === `test-hash:${password}`,
    }),
    audit: auditOn(trail, { now, newId: (() => { let n = 0; return () => `e${n++}`; })() }),
    attempts: attemptsOn(memoryAttempts().db, { now }),
    totp: totpsOn(memoryTotp().db, { now }),
    passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
});

describe('a sign-in with a password', () => {
  let app: FastifyInstance;
  let sessions: SessionStore;

  beforeEach(async () => {
    sessions = sessionsOn(memorySessions().db, { now });
    await identity.accounts.claim(accountContext(CORRELATION), CLAIM);
    app = Fastify({ logger: false });
    withSafeErrors(app);
    guardMutations(app, { sessions });
    serveSessionRoutes(app, { sessions, identity });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  test('never puts the password in the trail, refused or allowed', async () => {
    const wrong = 'not-the-real-passphrase-marker-4f9c';
    await app.inject({ method: 'POST', url: SESSION_PATH, headers: headersFor(), payload: { name: CLAIM.name, password: wrong } });
    await app.inject({
      method: 'POST',
      url: SESSION_PATH,
      headers: headersFor(),
      payload: { name: CLAIM.name, password: CLAIM.password },
    });
    expect(entries().length).toBeGreaterThan(0);
    expect(trailText()).not.toContain(wrong);
    expect(trailText()).not.toContain(CLAIM.password);
  });
});

describe('a second factor verified with a code', () => {
  let app: FastifyInstance;
  let sessions: SessionStore;
  let session: StartedSession;

  beforeEach(async () => {
    sessions = sessionsOn(memorySessions().db, { now });
    await identity.accounts.claim(accountContext(CORRELATION), CLAIM);
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

  test('never puts the code in the trail, refused or allowed', async () => {
    const enrolled = await app.inject({ method: 'POST', url: TOTP_PATH, headers: headersFor(session) });
    const secret = String(enrolled.json().data.secret);
    const real = codeAt(secret, stepAt(now()));
    const marker = 'redaction-marker-totp-code-7c31';

    await app.inject({
      method: 'POST',
      url: TOTP_VERIFICATION_PATH,
      headers: headersFor(session),
      payload: { code: marker },
    });
    await app.inject({
      method: 'POST',
      url: TOTP_VERIFICATION_PATH,
      headers: headersFor(session),
      payload: { code: real },
    });

    expect(entries().length).toBeGreaterThan(0);
    expect(trailText()).not.toContain(marker);
    expect(trailText()).not.toContain(real);
  });
});

describe('a passkey used to sign in', () => {
  let app: FastifyInstance;
  let sessions: SessionStore;
  let device: WebAuthnDevice;

  beforeEach(async () => {
    sessions = sessionsOn(memorySessions().db, { now });
    await identity.accounts.claim(accountContext(CORRELATION), CLAIM);
    device = webauthnDevice({ rpId: HOST, origin: ORIGIN });
    await identity.passkeys.register(passkeyContext(CORRELATION), ID, {
      id: device.credentialId,
      name: 'a registered key',
      publicKey: Buffer.from(device.publicKey).toString('base64url'),
      counter: 0,
      transports: ['internal'],
      synced: true,
    });
    app = Fastify({ logger: false });
    withSafeErrors(app);
    guardMutations(app, { sessions });
    serveSessionRoutes(app, { sessions, identity });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  test('never puts the signature in the trail, even for one that did not check out', async () => {
    const challenged = await app.inject({
      method: 'POST',
      url: SESSION_PATH,
      headers: headersFor(),
      payload: { passkey: { step: 'challenge' } },
    });
    const challenge = String(challenged.json().data.passkey.challenge);
    const produced = device.authenticate(challenge, { wrongSignature: true });

    await app.inject({
      method: 'POST',
      url: SESSION_PATH,
      headers: headersFor(),
      payload: {
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
            },
          },
        },
      },
    });

    expect(entries().length).toBeGreaterThan(0);
    expect(trailText()).not.toContain(produced.response.signature);
  });
});

describe('a settings change carrying the corpus credential', () => {
  let app: FastifyInstance;
  let admin: StartedSession;

  beforeEach(async () => {
    const sessions = sessionsOn(memorySessions().db, { now });
    const path = CANONICAL_SETTINGS_PATH;
    const seedToken = 'c'.repeat(24);
    const seedText = `corpusUrl: http://corpus:8080\ncorpusToken: ${seedToken}\n`;
    const loaded = loadSettings({ fileText: seedText, env: {}, path });
    const io = fakeSettingsIO({ [path]: seedText });
    const settingsAdmin = settingsAdminOn(loaded, { ...io, env: {} });
    app = Fastify({ logger: false });
    withSafeErrors(app);
    guardMutations(app, { sessions });
    serveSettingsRoutes(app, { settingsAdmin, identity });
    await app.ready();
    admin = await sessions.start(sessionContext(CORRELATION), {
      actor: `account:${'C'.repeat(22)}`,
      permissions: [SETTINGS_MANAGE],
    });
  });

  afterEach(async () => {
    await app.close();
  });

  test('never puts the corpus credential in the trail, only the field it changed', async () => {
    const marker = 'redaction-marker-corpus-token-9f2c8b1a';
    await app.inject({
      method: 'PATCH',
      url: SETTINGS_PATH,
      headers: headersFor(admin),
      payload: { corpusToken: marker },
    });
    expect(entries().length).toBeGreaterThan(0);
    expect(trailText()).not.toContain(marker);
    expect(trailText()).toContain('corpusToken');
  });
});
