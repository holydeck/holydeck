import { describe, expect, it } from 'vitest';

import { LiveTicketError, liveTicketsOn } from './live-tickets.js';

import type { CapabilityStore } from './capabilities.js';
import type { LiveTicketStore } from './live-tickets.js';

const START = Date.parse('2026-09-24T09:00:00.000Z');
const BINDING = { capabilityId: 'cap-1', service: 'service-1', view: 'audience' as const };
const CAPABILITY_EXPIRES_AT = '2026-09-24T21:00:00.000Z';

const harness = (): {
  readonly tickets: LiveTicketStore;
  readonly advance: (ms: number) => void;
  readonly revoke: (capabilityId: string | undefined) => void;
} => {
  let clockAt = START;
  const now = (): string => new Date(clockAt).toISOString();
  const listeners = new Set<(capabilityId: string | undefined) => void>();
  const capabilities: CapabilityStore = {
    onRevoked: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    issue: () => Promise.reject(new Error('not used by this harness')),
    redeem: () => Promise.reject(new Error('not used by this harness')),
    revoke: () => Promise.reject(new Error('not used by this harness')),
    revokeEvery: () => Promise.reject(new Error('not used by this harness')),
  };
  const tickets = liveTicketsOn(capabilities, { now });
  return {
    tickets,
    advance: (ms) => { clockAt += ms; },
    revoke: (capabilityId) => { for (const listener of listeners) listener(capabilityId); },
  };
};

const refused = (call: () => unknown): LiveTicketError => {
  try {
    call();
  } catch (error) {
    if (error instanceof LiveTicketError) return error;
    throw error;
  }
  throw new Error('the ticket was redeemed');
};

describe('minting the tickets a live exchange answers with (OUT-01)', () => {
  it('mints a socket ticket and a read ticket, each distinct from the other', () => {
    const { tickets } = harness();
    const minted = tickets.mint({ ...BINDING, capabilityExpiresAt: CAPABILITY_EXPIRES_AT });
    expect(minted.socketTicket).not.toBe(minted.readTicket);
    expect(minted.socketTicket.length).toBeGreaterThan(20);
    expect(minted.readTicket.length).toBeGreaterThan(20);
  });

  it('answers with the socket ticket’s own thirty-second expiry', () => {
    const { tickets } = harness();
    const minted = tickets.mint({ ...BINDING, capabilityExpiresAt: CAPABILITY_EXPIRES_AT });
    expect(minted.expiresAt).toBe(new Date(START + 30_000).toISOString());
  });
});

describe('redeeming a socket ticket, which opens one socket and no more (OUT-01)', () => {
  it('opens once, returning the binding it was minted for', () => {
    const { tickets } = harness();
    const minted = tickets.mint({ ...BINDING, capabilityExpiresAt: CAPABILITY_EXPIRES_AT });
    expect(tickets.redeemSocketTicket(minted.socketTicket)).toEqual(BINDING);
  });

  it('refuses a second redemption of the same socket ticket', () => {
    const { tickets } = harness();
    const minted = tickets.mint({ ...BINDING, capabilityExpiresAt: CAPABILITY_EXPIRES_AT });
    tickets.redeemSocketTicket(minted.socketTicket);
    const error = refused(() => tickets.redeemSocketTicket(minted.socketTicket));
    expect(error.kind).toBe('spent');
  });

  it('refuses a socket ticket once its thirty seconds have passed', () => {
    const { tickets, advance } = harness();
    const minted = tickets.mint({ ...BINDING, capabilityExpiresAt: CAPABILITY_EXPIRES_AT });
    advance(30_001);
    const error = refused(() => tickets.redeemSocketTicket(minted.socketTicket));
    expect(error.kind).toBe('expired');
  });

  it('refuses a socket ticket this store never minted', () => {
    const { tickets } = harness();
    const error = refused(() => tickets.redeemSocketTicket('never-minted'));
    expect(error.kind).toBe('unknown');
  });
});

describe('redeeming a read ticket, good for as long as the capability it came from (OUT-01)', () => {
  it('answers every call, not just the first', () => {
    const { tickets, advance } = harness();
    const minted = tickets.mint({ ...BINDING, capabilityExpiresAt: CAPABILITY_EXPIRES_AT });
    expect(tickets.redeemReadTicket(minted.readTicket)).toEqual(BINDING);
    advance(60_000);
    expect(tickets.redeemReadTicket(minted.readTicket)).toEqual(BINDING);
  });

  it('refuses a read ticket once the capability it was minted from has expired', () => {
    const { tickets, advance } = harness();
    const minted = tickets.mint({ ...BINDING, capabilityExpiresAt: new Date(START + 1000).toISOString() });
    advance(2000);
    const error = refused(() => tickets.redeemReadTicket(minted.readTicket));
    expect(error.kind).toBe('expired');
  });

  it('refuses a read ticket this store never minted', () => {
    const { tickets } = harness();
    const error = refused(() => tickets.redeemReadTicket('never-minted'));
    expect(error.kind).toBe('unknown');
  });
});

describe('a revoked capability forgets every ticket it minted (OUT-01)', () => {
  it('invalidates that capability’s own outstanding tickets, and no other capability’s', () => {
    const { tickets, revoke } = harness();
    const own = tickets.mint({ ...BINDING, capabilityExpiresAt: CAPABILITY_EXPIRES_AT });
    const otherBinding = { capabilityId: 'cap-2', service: 'service-1', view: 'audience' as const };
    const other = tickets.mint({ ...otherBinding, capabilityExpiresAt: CAPABILITY_EXPIRES_AT });
    revoke(BINDING.capabilityId);
    expect(refused(() => tickets.redeemSocketTicket(own.socketTicket)).kind).toBe('unknown');
    expect(refused(() => tickets.redeemReadTicket(own.readTicket)).kind).toBe('unknown');
    expect(tickets.redeemSocketTicket(other.socketTicket)).toEqual(otherBinding);
  });

  it('a blanket revocation forgets every ticket, not just one capability’s', () => {
    const { tickets, revoke } = harness();
    const minted = tickets.mint({ ...BINDING, capabilityExpiresAt: CAPABILITY_EXPIRES_AT });
    revoke(undefined);
    const error = refused(() => tickets.redeemSocketTicket(minted.socketTicket));
    expect(error.kind).toBe('unknown');
  });
});
