import { describe, expect, it } from 'vitest';

import { capabilityContext, capabilitiesOn, tokenDigest } from './capabilities.js';
import { GuestJoinError, admitGuest, admitOutput } from './guest-join.js';
import { VIEW_GRANTS } from './live-protocol.js';
import { serviceContext, servicesOn } from './services.js';

import type { CapabilityStore } from './capabilities.js';
import type { ServiceState } from '@holydeck/contracts/services';
import type { ServiceStore } from './services.js';

import { memoryCapabilities } from '../test/helpers/capabilities.js';
import { fakeDb } from '../test/helpers/fake-db.js';

const ADMINISTRATOR = `account:${'D'.repeat(22)}`;
const CORRELATION = 'req-guest-join-0001';
const DRAFT = { title: 'Sunday Morning', date: '2026-09-20', site: 'Main Hall', sections: [] };
const START = Date.parse('2026-09-20T09:00:00.000Z');

const harness = (): { services: ServiceStore; capabilities: CapabilityStore; advance: (ms: number) => void } => {
  let clockAt = START;
  const now = (): string => new Date(clockAt).toISOString();
  return {
    services: servicesOn(fakeDb(), { now }),
    capabilities: capabilitiesOn(memoryCapabilities().db, { now }),
    advance: (ms) => {
      clockAt += ms;
    },
  };
};

const serviceAt = async (services: ServiceStore, ...states: readonly ServiceState[]): Promise<string> => {
  const context = serviceContext(ADMINISTRATOR, CORRELATION);
  const created = await services.create(context, DRAFT);
  for (const state of states) await services.transition(context, created.stamp.id, state);
  return created.stamp.id;
};

const guestToken = async (capabilities: CapabilityStore, service: string, expiresAt: string): Promise<string> => {
  const { token } = await capabilities.issue(capabilityContext(CORRELATION), ADMINISTRATOR, {
    kind: 'guest', service, view: 'audience', expiresAt,
  });
  return token;
};

const refused = async (call: Promise<unknown>): Promise<GuestJoinError> => {
  try {
    await call;
  } catch (error) {
    if (error instanceof GuestJoinError) return error;
    throw error;
  }
  throw new Error('the join was allowed');
};

describe('a Guest joining the Audience view', () => {
  it('grants watch-only access to the Audience view with no name, email or account', async () => {
    const { services, capabilities } = harness();
    const service = await serviceAt(services, 'presenting');
    const token = await guestToken(capabilities, service, new Date(START + 60_000).toISOString());
    const grant = await admitGuest(capabilities, services, CORRELATION, { token, service, view: 'audience' });
    expect(grant).toEqual({ ...VIEW_GRANTS.audience, capabilityId: tokenDigest(token) });
    expect(Object.keys(grant)).toEqual(['watch', 'command', 'capabilityId']);
  });

  it('refuses a capability that has expired (time-scoped)', async () => {
    const { services, capabilities, advance } = harness();
    const service = await serviceAt(services, 'presenting');
    const token = await guestToken(capabilities, service, new Date(START + 1000).toISOString());
    advance(2000);
    const error = await refused(admitGuest(capabilities, services, CORRELATION, { token, service, view: 'audience' }));
    expect(error.kind).toBe('capability');
  });

  it('refuses a capability presented against a different service (service-scoped)', async () => {
    const { services, capabilities } = harness();
    const service = await serviceAt(services, 'presenting');
    const token = await guestToken(capabilities, service, new Date(START + 60_000).toISOString());
    const error = await refused(
      admitGuest(capabilities, services, CORRELATION, { token, service: 'a-different-service', view: 'audience' }),
    );
    expect(error.kind).toBe('capability');
  });

  it('refuses a capability presented against a different view (view-scoped)', async () => {
    const { services, capabilities } = harness();
    const service = await serviceAt(services, 'presenting');
    const token = await guestToken(capabilities, service, new Date(START + 60_000).toISOString());
    const error = await refused(admitGuest(capabilities, services, CORRELATION, { token, service, view: 'stage' }));
    expect(error.kind).toBe('capability');
  });

  it('refuses a capability that has been revoked', async () => {
    const { services, capabilities } = harness();
    const service = await serviceAt(services, 'presenting');
    const { token, capabilityId } = await capabilities.issue(capabilityContext(CORRELATION), ADMINISTRATOR, {
      kind: 'guest', service, view: 'audience', expiresAt: new Date(START + 60_000).toISOString(),
    });
    await capabilities.revoke(capabilityContext(CORRELATION), capabilityId);
    const error = await refused(admitGuest(capabilities, services, CORRELATION, { token, service, view: 'audience' }));
    expect(error.kind).toBe('capability');
  });

  it('refuses an output-kind capability, which opens no Guest join', async () => {
    const { services, capabilities } = harness();
    const service = await serviceAt(services, 'presenting');
    const { token } = await capabilities.issue(capabilityContext(CORRELATION), ADMINISTRATOR, {
      kind: 'output', service, view: 'audience', expiresAt: new Date(START + 60_000).toISOString(),
    });
    const error = await refused(admitGuest(capabilities, services, CORRELATION, { token, service, view: 'audience' }));
    expect(error.kind).toBe('capability');
  });

  it('lets an error the capability store did not name pass through unchanged', async () => {
    const { services } = harness();
    const defect = new TypeError('mongodb://holydeck:hunter2@records.invalid:27017 is not a function');
    const broken: CapabilityStore = {
      onRevoked: () => () => {},
      issue: () => Promise.reject(defect),
      redeem: () => Promise.reject(defect),
      revoke: () => Promise.reject(defect),
      revokeEvery: () => Promise.reject(defect),
    };
    await expect(
      admitGuest(broken, services, CORRELATION, { token: 'x', service: 'service-1', view: 'audience' }),
    ).rejects.toBe(defect);
  });

  const notPresenting: ReadonlyMap<string, readonly ServiceState[]> = new Map([
    ['upcoming', []],
    ['completed', ['presenting', 'completed']],
    ['archived', ['presenting', 'completed', 'archived']],
  ]);

  for (const [label, states] of notPresenting) {
    it(`refuses a join while the Service is ${label}`, async () => {
      const { services, capabilities } = harness();
      const service = await serviceAt(services, ...states);
      const token = await guestToken(capabilities, service, new Date(START + 60_000).toISOString());
      const error = await refused(admitGuest(capabilities, services, CORRELATION, { token, service, view: 'audience' }));
      expect(error.kind).toBe('state');
    });
  }
});

describe('an output window opening one of its channels', () => {
  it('grants watch-only access to the view its capability names, whatever state the Service is in', async () => {
    const { services, capabilities } = harness();
    const service = await serviceAt(services);
    const { token } = await capabilities.issue(capabilityContext(CORRELATION), ADMINISTRATOR, {
      kind: 'output', service, view: 'stage', expiresAt: new Date(START + 60_000).toISOString(),
    });
    const grant = await admitOutput(capabilities, CORRELATION, { token, service, view: 'stage' });
    expect(grant).toEqual({ ...VIEW_GRANTS.stage, capabilityId: tokenDigest(token) });
  });

  it('refuses a capability that has expired', async () => {
    const { capabilities, advance } = harness();
    const { token } = await capabilities.issue(capabilityContext(CORRELATION), ADMINISTRATOR, {
      kind: 'output', service: 'service-1', view: 'audience', expiresAt: new Date(START + 1000).toISOString(),
    });
    advance(2000);
    const error = await refused(
      admitOutput(capabilities, CORRELATION, { token, service: 'service-1', view: 'audience' }),
    );
    expect(error.kind).toBe('capability');
  });

  it('refuses a capability presented against a different service', async () => {
    const { capabilities } = harness();
    const { token } = await capabilities.issue(capabilityContext(CORRELATION), ADMINISTRATOR, {
      kind: 'output', service: 'service-1', view: 'audience', expiresAt: new Date(START + 60_000).toISOString(),
    });
    const error = await refused(
      admitOutput(capabilities, CORRELATION, { token, service: 'a-different-service', view: 'audience' }),
    );
    expect(error.kind).toBe('capability');
  });

  it('refuses a capability presented against a different view', async () => {
    const { capabilities } = harness();
    const { token } = await capabilities.issue(capabilityContext(CORRELATION), ADMINISTRATOR, {
      kind: 'output', service: 'service-1', view: 'stage', expiresAt: new Date(START + 60_000).toISOString(),
    });
    const error = await refused(
      admitOutput(capabilities, CORRELATION, { token, service: 'service-1', view: 'audience' }),
    );
    expect(error.kind).toBe('capability');
  });

  it('refuses a capability that has been revoked', async () => {
    const { capabilities } = harness();
    const { token, capabilityId } = await capabilities.issue(capabilityContext(CORRELATION), ADMINISTRATOR, {
      kind: 'output', service: 'service-1', view: 'audience', expiresAt: new Date(START + 60_000).toISOString(),
    });
    await capabilities.revoke(capabilityContext(CORRELATION), capabilityId);
    const error = await refused(
      admitOutput(capabilities, CORRELATION, { token, service: 'service-1', view: 'audience' }),
    );
    expect(error.kind).toBe('capability');
  });

  it('refuses a guest-kind capability, which opens no output window', async () => {
    const { capabilities } = harness();
    const { token } = await capabilities.issue(capabilityContext(CORRELATION), ADMINISTRATOR, {
      kind: 'guest', service: 'service-1', view: 'audience', expiresAt: new Date(START + 60_000).toISOString(),
    });
    const error = await refused(
      admitOutput(capabilities, CORRELATION, { token, service: 'service-1', view: 'audience' }),
    );
    expect(error.kind).toBe('capability');
  });
});
