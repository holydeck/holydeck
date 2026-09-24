import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { GUEST_EXCHANGE_PATH, OUTPUT_EXCHANGE_PATH } from '@holydeck/contracts/live';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { capabilityContext, capabilitiesOn, tokenDigest } from './capabilities.js';
import { withSafeErrors } from './failures.js';
import { serveLiveExchangeRoutes } from './live-exchange-routes.js';
import { liveTicketsOn } from './live-tickets.js';
import { passkeysOn } from './passkeys.js';
import { serviceContext, servicesOn } from './services.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { memoryCapabilities } from '../test/helpers/capabilities.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { CapabilityStore } from './capabilities.js';
import type { LiveTicketStore } from './live-tickets.js';
import type { Identity } from './onboarding.js';
import type { Document } from './repositories.js';
import type { ServiceStore } from './services.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance } from 'fastify';

const NOW = '2026-09-13T09:30:00.000Z';
const CORRELATION = 'req-live-exchange-0001';
const ADMINISTRATOR = `account:${'D'.repeat(22)}`;
const DRAFT = { title: 'Sunday Morning', date: '2026-09-20', site: 'Main Hall', sections: [] };

let app: FastifyInstance;
let capabilities: CapabilityStore;
let services: ServiceStore;
let liveTickets: LiveTicketStore;
let trail: FakeDb;
let identity: Identity;
let clock: number;

const now = (): string => new Date(clock).toISOString();
const entries = (): Document[] => trail.rows.get('audit_events') ?? [];
const actions = (): unknown[] => entries().map((entry) => entry['action']);
const version = { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current) };

const serviceAt = async (...states: readonly ('presenting' | 'completed' | 'archived')[]): Promise<string> => {
  const context = serviceContext(ADMINISTRATOR, CORRELATION);
  const created = await services.create(context, DRAFT);
  for (const state of states) await services.transition(context, created.stamp.id, state);
  return created.stamp.id;
};

const issuing = async (
  kind: 'guest' | 'output',
  service: string,
  view: 'audience' | 'stage' | 'singer',
  expiresAt: string,
): Promise<string> => {
  const { token } = await capabilities.issue(capabilityContext(CORRELATION), ADMINISTRATOR, {
    kind, service, view, expiresAt,
  });
  return token;
};

const buildApp = (): FastifyInstance => {
  const built = Fastify({ logger: false });
  withSafeErrors(built);
  serveLiveExchangeRoutes(built, { capabilities, services, liveTickets, identity });
  return built;
};

beforeEach(async () => {
  clock = Date.parse(NOW);
  trail = fakeDb();
  capabilities = capabilitiesOn(memoryCapabilities().db, { now });
  services = servicesOn(fakeDb(), { now });
  liveTickets = liveTicketsOn(capabilities, { now });
  identity = {
    accounts: accountsOn(memoryAccounts().db, { now }),
    audit: auditOn(trail, { now, newId: () => `e${entries().length}` }),
    attempts: attemptsOn(memoryAttempts().db, { now }),
    totp: totpsOn(memoryTotp().db, { now }),
    passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
  app = buildApp();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('exchanging a Guest join token', () => {
  test('answers a socket ticket and a read ticket for a valid capability', async () => {
    const service = await serviceAt('presenting');
    const token = await issuing('guest', service, 'audience', new Date(clock + 60_000).toISOString());
    const response = await app.inject({
      method: 'POST',
      url: GUEST_EXCHANGE_PATH,
      headers: version,
      payload: { token, service },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    expect(body.view).toBe('audience');
    expect(typeof body.socketTicket).toBe('string');
    expect(typeof body.readTicket).toBe('string');
    expect(body.expiresAt).toBe(new Date(clock + 60_000).toISOString());
    expect(actions()).toEqual(['live.guest.exchange']);
    expect(entries()[0]).toMatchObject({ outcome: 'allowed', subject: tokenDigest(token) });
  });

  test('refuses an output-kind capability, which opens no Guest join', async () => {
    const service = await serviceAt('presenting');
    const token = await issuing('output', service, 'audience', new Date(clock + 60_000).toISOString());
    const response = await app.inject({
      method: 'POST', url: GUEST_EXCHANGE_PATH, headers: version, payload: { token, service },
    });
    expect(response.statusCode).toBe(403);
    expect(actions()).toEqual(['live.guest.exchange']);
    expect(entries()[0]).toMatchObject({ outcome: 'refused' });
  });

  test('refuses an expired capability', async () => {
    const service = await serviceAt('presenting');
    const token = await issuing('guest', service, 'audience', new Date(clock + 1000).toISOString());
    clock += 2000;
    const response = await app.inject({
      method: 'POST', url: GUEST_EXCHANGE_PATH, headers: version, payload: { token, service },
    });
    expect(response.statusCode).toBe(403);
  });

  test('refuses a revoked capability', async () => {
    const service = await serviceAt('presenting');
    const { token, capabilityId } = await capabilities.issue(capabilityContext(CORRELATION), ADMINISTRATOR, {
      kind: 'guest', service, view: 'audience', expiresAt: new Date(clock + 60_000).toISOString(),
    });
    await capabilities.revoke(capabilityContext(CORRELATION), capabilityId);
    const response = await app.inject({
      method: 'POST', url: GUEST_EXCHANGE_PATH, headers: version, payload: { token, service },
    });
    expect(response.statusCode).toBe(403);
  });

  test('never carries the token itself, in the response or the audit trail', async () => {
    const service = await serviceAt('presenting');
    const token = await issuing('guest', service, 'audience', new Date(clock + 60_000).toISOString());
    const response = await app.inject({
      method: 'POST', url: GUEST_EXCHANGE_PATH, headers: version, payload: { token, service },
    });
    expect(JSON.stringify(response.json())).not.toContain(token);
    expect(JSON.stringify(entries())).not.toContain(token);
  });
});

describe('exchanging an output window capability', () => {
  test('answers tickets scoped to the view the capability names, whatever state the Service is in', async () => {
    const service = await serviceAt();
    const token = await issuing('output', service, 'stage', new Date(clock + 60_000).toISOString());
    const response = await app.inject({
      method: 'POST', url: OUTPUT_EXCHANGE_PATH, headers: version, payload: { token, service, view: 'stage' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.view).toBe('stage');
    expect(actions()).toEqual(['live.output.exchange']);
  });

  test('refuses a guest-kind capability, which opens no output window', async () => {
    const service = await serviceAt();
    const token = await issuing('guest', service, 'audience', new Date(clock + 60_000).toISOString());
    const response = await app.inject({
      method: 'POST', url: OUTPUT_EXCHANGE_PATH, headers: version, payload: { token, service, view: 'audience' },
    });
    expect(response.statusCode).toBe(403);
  });

  test('refuses a capability presented against a different view', async () => {
    const service = await serviceAt();
    const token = await issuing('output', service, 'stage', new Date(clock + 60_000).toISOString());
    const response = await app.inject({
      method: 'POST', url: OUTPUT_EXCHANGE_PATH, headers: version, payload: { token, service, view: 'singer' },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('the exchange rate limit', () => {
  test('trips at the eleventh request in a minute from one caller', async () => {
    const service = await serviceAt('presenting');
    let last: Awaited<ReturnType<typeof app.inject>> | undefined;
    for (let request = 0; request < 11; request += 1) {
      last = await app.inject({
        method: 'POST', url: GUEST_EXCHANGE_PATH, headers: version, payload: { token: 'nope', service },
      });
    }
    expect(last?.statusCode).toBe(429);
    expect(last?.json().error.code).toBe('live.exchange_rate_limited');
  });
});

describe('a deployment with nowhere to keep a capability', () => {
  test('answers not-found on both exchange paths rather than a defect', async () => {
    const bare = Fastify({ logger: false });
    withSafeErrors(bare);
    serveLiveExchangeRoutes(bare, { capabilities: undefined, services: undefined, liveTickets: undefined, identity });
    await bare.ready();
    const guest = await bare.inject({
      method: 'POST', url: GUEST_EXCHANGE_PATH, headers: version, payload: { token: 'x', service: 's' },
    });
    const output = await bare.inject({
      method: 'POST', url: OUTPUT_EXCHANGE_PATH, headers: version, payload: { token: 'x', service: 's', view: 'audience' },
    });
    expect(guest.statusCode).toBe(404);
    expect(output.statusCode).toBe(404);
    await bare.close();
  });
});
