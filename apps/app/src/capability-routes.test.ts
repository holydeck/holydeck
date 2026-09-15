import { actorFor } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { VALIDATION_FAILED } from '@holydeck/contracts/http';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { CapabilityError, capabilitiesOn, capabilityContext } from './capabilities.js';
import {
  CAPABILITIES_PATH,
  GUEST_INVITATION_PATH,
  OUTPUT_CAPABILITY_PATH,
  serveCapabilityRoutes,
} from './capability-routes.js';
import { FORBIDDEN, guardMutations, mutatingRoutesOf } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { passkeysOn } from './passkeys.js';
import { PRESENTATION_CONTROL } from './roles.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { memoryCapabilities } from '../test/helpers/capabilities.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { CapabilityStore } from './capabilities.js';
import type { Identity } from './onboarding.js';
import type { Document } from './repositories.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance, InjectOptions } from 'fastify';

const NOW = '2026-09-13T09:30:00.000Z';
const EXPIRES = '2026-09-13T10:30:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const CORRELATION = 'req-0f9c2a41';
const SERVICE = 'sunday-service';

/** The operator granting a capability is never the one it is granted to — a capability carries no actor. */
const OPERATOR = actorFor('C'.repeat(22));

let app: FastifyInstance;
let sessions: SessionStore;
let capabilities: CapabilityStore;
let trail: FakeDb;
let identity: Identity;
let operator: StartedSession;
let clock: number;

const now = (): string => new Date(clock).toISOString();

const entries = (): Document[] => trail.rows.get('audit_events') ?? [];

const actions = (): unknown[] => entries().map((entry) => entry['action']);

const revokePath = (id: string): string => `${CAPABILITIES_PATH}/${id}`;

const asking = (method: 'POST' | 'DELETE', url: string, payload?: unknown, held: StartedSession = operator) =>
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

const issuingGuest = (body: unknown = { service: SERVICE, expiresAt: EXPIRES }, held?: StartedSession) =>
  asking('POST', GUEST_INVITATION_PATH, body, held);

const issuingOutput = (
  body: unknown = { service: SERVICE, view: 'stage', expiresAt: EXPIRES },
  held?: StartedSession,
) => asking('POST', OUTPUT_CAPABILITY_PATH, body, held);

beforeEach(async () => {
  clock = Date.parse(NOW);
  trail = fakeDb();
  sessions = sessionsOn(memorySessions().db, { now });
  capabilities = capabilitiesOn(memoryCapabilities().db, { now });
  identity = {
    accounts: accountsOn(memoryAccounts().db, { now }),
    audit: auditOn(trail, { now, newId: () => `e${entries().length}` }),
    attempts: attemptsOn(memoryAttempts().db, { now }),
    totp: totpsOn(memoryTotp().db, { now }),
    passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
  app = Fastify({ logger: false });
  withSafeErrors(app);
  guardMutations(app, { sessions });
  enforceAuthorization(app, { sessions, identity: undefined });
  serveCapabilityRoutes(app, { capabilities, identity });
  await app.ready();
  operator = await sessions.start(sessionContext(CORRELATION), { actor: OPERATOR, permissions: [PRESENTATION_CONTROL] });
});

afterEach(async () => {
  await app.close();
});

describe('issuing a guest invitation', () => {
  test('answers a token scoped to the audience view, for the service and the expiry asked', async () => {
    const response = await issuingGuest();
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({ kind: 'guest', service: SERVICE, view: 'audience', expiresAt: EXPIRES });
    expect(typeof response.json().data.token).toBe('string');
    expect(typeof response.json().data.capabilityId).toBe('string');
  });

  test('grants the audience view even when the caller sent another, because a guest chooses no view', async () => {
    const response = await issuingGuest({ service: SERVICE, view: 'stage', expiresAt: EXPIRES });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.view).toBe('audience');
  });

  test('the token reaches the caller only in the body: no cookie is set and nothing redirects', async () => {
    const response = await issuingGuest();
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.statusCode).toBeLessThan(300);
  });

  test('a service that is missing is said plainly', async () => {
    const response = await issuingGuest({ expiresAt: EXPIRES });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(response.json().error.fields[0].path).toBe('guestInvitation.service');
  });

  test('a service that is empty is said plainly, the same as one that is missing', async () => {
    const response = await issuingGuest({ service: '', expiresAt: EXPIRES });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields[0].path).toBe('guestInvitation.service');
  });

  test('an expiry that is not a UTC instant is refused at the shape it was sent in', async () => {
    const response = await issuingGuest({ service: SERVICE, expiresAt: 'tomorrow' });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields[0].path).toBe('guestInvitation.expiresAt');
  });

  test('an expiry already in the past is refused by the store, not by the shape it arrived in', async () => {
    const response = await issuingGuest({ service: SERVICE, expiresAt: PAST });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(response.json().error.fields[0].path).toBe('expiresAt');
  });
});

describe('issuing an output capability', () => {
  test('answers a token for the service, view and expiry asked, and never can control', async () => {
    const response = await issuingOutput();
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({ kind: 'output', service: SERVICE, view: 'stage', expiresAt: EXPIRES });
  });

  test('the audience view is issued exactly as asked, alongside the stage view', async () => {
    const response = await issuingOutput({ service: SERVICE, view: 'audience', expiresAt: EXPIRES });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.view).toBe('audience');
  });

  test('a view that is not audience or stage is refused, and live-control is never an answer this route gives', async () => {
    const response = await issuingOutput({ service: SERVICE, view: 'live-control', expiresAt: EXPIRES });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields[0].path).toBe('outputCapability.view');
  });

  test('a service that is missing is said plainly', async () => {
    const response = await issuingOutput({ view: 'stage', expiresAt: EXPIRES });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields[0].path).toBe('outputCapability.service');
  });

  test('an expiry already in the past is refused by the store, not by the shape it arrived in', async () => {
    const response = await issuingOutput({ service: SERVICE, view: 'stage', expiresAt: PAST });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields[0].path).toBe('expiresAt');
  });
});

describe('revoking a capability', () => {
  test('answers that it was revoked, and nothing further can be redeemed with it', async () => {
    const issued = await issuingOutput();
    const response = await asking('DELETE', revokePath(issued.json().data.capabilityId));
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ revoked: true });
  });

  test('is idempotent: a capability nothing holds is answered the same way, because revoking is not proof it existed', async () => {
    const response = await asking('DELETE', revokePath('nothing-issued-this'));
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ revoked: true });
  });
});

describe('who may ask any of it', () => {
  test('every route here changes something, and so every one is behind the guard', () => {
    expect(mutatingRoutesOf(app)).toEqual([
      { method: 'POST', url: GUEST_INVITATION_PATH },
      { method: 'POST', url: OUTPUT_CAPABILITY_PATH },
      { method: 'DELETE', url: `${CAPABILITIES_PATH}/:capabilityId` },
    ]);
  });

  test('refuses a request that carries no session at all', async () => {
    const response = await app.inject({
      method: 'POST',
      url: GUEST_INVITATION_PATH,
      headers: { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current), host: HOST, origin: ORIGIN },
      payload: { service: SERVICE, expiresAt: EXPIRES },
    });
    expect(response.statusCode).toBe(401);
  });

  test('refuses a session that carries no presentation.control permission, for every route here', async () => {
    const bystander = await sessions.start(sessionContext(CORRELATION), { actor: OPERATOR, permissions: [] });
    for (const response of [
      await issuingGuest(undefined, bystander),
      await issuingOutput(undefined, bystander),
      await asking('DELETE', revokePath('whatever'), undefined, bystander),
    ]) {
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe(FORBIDDEN);
    }
  });
});

describe('the trail this surface writes', () => {
  test('records who was granted a guest invitation, for which service and until when', async () => {
    await issuingGuest();
    expect(actions()).toEqual(['capability.guest.issue']);
    expect(entries()[0]).toMatchObject({ actor: OPERATOR, subject: OPERATOR, outcome: 'allowed' });
    expect(String(entries()[0]?.['detail'])).toContain(SERVICE);
  });

  test('records who was granted an output capability, for which service, view and until when', async () => {
    await issuingOutput();
    expect(actions()).toEqual(['capability.output.issue']);
    expect(String(entries()[0]?.['detail'])).toContain('stage');
  });

  test('records that a capability was revoked, and by whom', async () => {
    const issued = await issuingOutput();
    await asking('DELETE', revokePath(issued.json().data.capabilityId));
    expect(actions()).toEqual(['capability.output.issue', 'capability.revoke']);
    expect(entries()[1]).toMatchObject({ actor: OPERATOR, subject: OPERATOR, outcome: 'allowed' });
  });

  test('never writes the token itself into the trail', async () => {
    const issued = await issuingGuest();
    expect(JSON.stringify(entries())).not.toContain(issued.json().data.token);
  });

  test('writes nothing for a request the shape of the body refused', async () => {
    await issuingGuest({ expiresAt: EXPIRES });
    expect(entries()).toEqual([]);
  });
});

describe('what this surface refuses to answer at all', () => {
  const serving = async (bag: CapabilityStore | undefined, held: Identity | undefined): Promise<FastifyInstance> => {
    const built = Fastify({ logger: false });
    withSafeErrors(built);
    guardMutations(built, { sessions });
    enforceAuthorization(built, { sessions, identity: undefined });
    serveCapabilityRoutes(built, { capabilities: bag, identity: held });
    await built.ready();
    return built;
  };

  test('a deployment that keeps no capabilities serves every path, and answers not-found from each', async () => {
    await app.close();
    app = await serving(undefined, identity);
    expect((await issuingGuest()).statusCode).toBe(404);
    expect((await issuingOutput()).statusCode).toBe(404);
    expect((await asking('DELETE', revokePath('whatever'))).statusCode).toBe(404);
  });

  test('a trail that refuses an entry does not cost the caller the capability they were issued', async () => {
    await app.close();
    identity = { ...identity, audit: { record: () => Promise.reject(new Error('the trail is unavailable')) } };
    app = await serving(capabilities, identity);
    const response = await issuingGuest();
    expect(response.statusCode).toBe(201);
  });

  test('a store refusal other than a schema disagreement is this server’s defect, not a capability’s answer', async () => {
    await app.close();
    app = await serving(
      { ...capabilities, issue: () => Promise.reject(new CapabilityError('permission', 'capabilities: the actor may not issue')) },
      identity,
    );
    expect((await issuingGuest()).statusCode).toBe(500);
    expect((await issuingOutput()).statusCode).toBe(500);
  });

  test('issues a capability even when this deployment keeps no identity to audit it against', async () => {
    await app.close();
    app = await serving(capabilities, undefined);
    expect((await issuingGuest()).statusCode).toBe(201);
  });
});

describe('what an operator’s session is not', () => {
  test('a capability is redeemed by the token alone, and a session that issued one carries no trace of it', async () => {
    const issued = await issuingOutput();
    expect(
      await capabilities.redeem(capabilityContext(CORRELATION), issued.json().data.token, {
        service: SERVICE,
        view: 'stage',
      }),
    ).toMatchObject({ kind: 'output', canControl: false, grants: [] });
  });
});
