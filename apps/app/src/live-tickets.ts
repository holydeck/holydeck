// The two tickets an output exchange answers with (spec OUT-01), derived from an already-redeemed
// capability so the long-lived capability token itself never has to reach a browser a second time: a
// `socketTicket` that opens exactly one WebSocket handshake within thirty seconds, and a `readTicket` that
// answers `X-Holydeck-Live-Ticket` for as long as the capability it was minted from is still good.
//
// Both live in memory only, on purpose. `capabilities.ts`'s own `redeem` is non-consuming — it re-checks
// expiry, service and view live against the store on every call, never marking a token spent — so nothing
// here needs to survive a restart: a client that finds its tickets gone simply repeats the exchange
// against the capability it is still holding. What this store adds, that `capabilities.ts` does not, is
// the single-use rule OUT-01 asks of the socket ticket specifically (D-PLAN-5) — tracked here, in a plain
// `Map`, because nothing about "spent" belongs to the capability itself.
//
// Ticket values are drawn the same way a capability token is (`randomBytes(...).toString('base64url')`,
// `capabilities.ts`), for the same entropy. They are not hashed before being kept as this store's own map
// keys: hashing guards a token that reaches a database another reader might leak; these values never
// leave process memory.

import { randomBytes } from 'node:crypto';

import { TICKET_SECONDS } from '@holydeck/contracts/sessions';

import type { CapabilityStore, CapabilityView } from './capabilities.js';

const TICKET_BYTES = 32;

export type LiveTicketRefusal = 'unknown' | 'spent' | 'expired';

/** Carries why a ticket redemption was refused, so a caller can log a defect apart from an ordinary
 *  "that ticket is no longer good," which a socket ticket's single use makes routine. */
export class LiveTicketError extends Error {
  readonly kind: LiveTicketRefusal;

  constructor(kind: LiveTicketRefusal, message: string) {
    super(message);
    this.name = 'LiveTicketError';
    this.kind = kind;
  }
}

/** What both tickets this store mints are bound to: the capability they were derived from, and the one
 *  service and view it redeemed against — the same triple `capabilities.ts` checks `redeem` against. */
export interface LiveTicketBinding {
  readonly capabilityId: string;
  readonly service: string;
  readonly view: CapabilityView;
}

export interface LiveTicketMintInput extends LiveTicketBinding {
  /** When the capability these tickets are derived from stops being good — read, never written, by this
   *  store: the capability's own expiry is `capabilities.ts`'s to own, this store only remembers it. */
  readonly capabilityExpiresAt: string;
}

export interface MintedLiveTickets {
  readonly socketTicket: string;
  readonly readTicket: string;
  /** The socket ticket's own expiry — thirty seconds out, the one OUT-01 asks for. The read ticket's is
   *  `capabilityExpiresAt`, already known to the caller that minted it, so it is not repeated here. */
  readonly expiresAt: string;
}

export interface LiveTicketOptions {
  /** Explicit, so a test can move the clock instead of waiting out a real thirty seconds. */
  readonly now?: () => string;
}

export interface LiveTicketStore {
  mint(input: LiveTicketMintInput): MintedLiveTickets;
  /** Redeems and, in the same call, spends a socket ticket: a second call with the same value refuses. */
  redeemSocketTicket(ticket: string): LiveTicketBinding;
  /** Redeems a read ticket without spending it — good again on the very next call, until its capability
   *  expires or is revoked. */
  redeemReadTicket(ticket: string): LiveTicketBinding;
}

interface StoredSocketTicket {
  readonly binding: LiveTicketBinding;
  readonly expiresAtMs: number;
  spent: boolean;
}

interface StoredReadTicket {
  readonly binding: LiveTicketBinding;
  readonly capabilityExpiresAtMs: number;
}

const newTicket = (): string => randomBytes(TICKET_BYTES).toString('base64url');

/** Builds a ticket store bound to one capability store's revocations: every ticket minted from a
 *  capability is forgotten the moment that capability is (T32's `onRevoked`), whether it was revoked by
 *  itself or swept up in a `revokeEvery` that names none in particular. */
export function liveTicketsOn(capabilities: CapabilityStore, options: LiveTicketOptions = {}): LiveTicketStore {
  const now = options.now ?? ((): string => new Date().toISOString());
  const socketTickets = new Map<string, StoredSocketTicket>();
  const readTickets = new Map<string, StoredReadTicket>();

  capabilities.onRevoked((capabilityId) => {
    for (const [ticket, stored] of socketTickets) {
      if (capabilityId === undefined || stored.binding.capabilityId === capabilityId) {
        socketTickets.delete(ticket);
      }
    }
    for (const [ticket, stored] of readTickets) {
      if (capabilityId === undefined || stored.binding.capabilityId === capabilityId) {
        readTickets.delete(ticket);
      }
    }
  });

  return {
    mint(input) {
      const binding: LiveTicketBinding = { capabilityId: input.capabilityId, service: input.service, view: input.view };
      const nowMs = Date.parse(now());
      const expiresAtMs = nowMs + TICKET_SECONDS * 1000;
      const socketTicket = newTicket();
      const readTicket = newTicket();
      socketTickets.set(socketTicket, { binding, expiresAtMs, spent: false });
      readTickets.set(readTicket, { binding, capabilityExpiresAtMs: Date.parse(input.capabilityExpiresAt) });
      return { socketTicket, readTicket, expiresAt: new Date(expiresAtMs).toISOString() };
    },

    redeemSocketTicket(ticket) {
      const stored = socketTickets.get(ticket);
      if (stored === undefined) {
        throw new LiveTicketError('unknown', 'that socket ticket is not one this store minted');
      }
      if (stored.spent) {
        throw new LiveTicketError('spent', 'that socket ticket has already opened its one socket');
      }
      stored.spent = true;
      if (Date.parse(now()) >= stored.expiresAtMs) {
        throw new LiveTicketError('expired', 'that socket ticket’s thirty seconds have passed');
      }
      return stored.binding;
    },

    redeemReadTicket(ticket) {
      const stored = readTickets.get(ticket);
      if (stored === undefined) {
        throw new LiveTicketError('unknown', 'that read ticket is not one this store minted');
      }
      if (Date.parse(now()) >= stored.capabilityExpiresAtMs) {
        readTickets.delete(ticket);
        throw new LiveTicketError('expired', 'the capability that read ticket was minted from has expired');
      }
      return stored.binding;
    },
  };
}
