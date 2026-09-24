// Admitting two different callers to a live channel (spec LIVE-03, 9.3, 9.5, OUT-02): an anonymous Guest
// to the Audience view, and an output window to whichever view its capability names. Both gate on the
// same first check, read live and never cached — the capability itself, T32's `capabilities.ts`, redeemed
// against the service and view the caller names — and only a Guest's join gates on a second: the Service
// that capability names must be Presenting (`joinAllowedFor`, T44, ADR 0002) or the join is refused, even
// though the capability itself redeemed clean. An output window carries no such gate (OUT-02): a
// controller opens its own output windows while rehearsing, long before a Service presents, so
// `admitOutput` accepts a redeemed `output` capability in any Service state.
//
// What redeeming answers with carries no identity at all (`RedeemedCapability`'s `guest` and `output`
// arms alike), and nothing here adds one: a `LiveGrant` names a view to watch, never who is watching it —
// spec 9.5's whole privacy contract is kept by there being no field here for a name, an email or an
// account to go in, not by a promise to leave one blank.
//
// Wiring either grant into an actual live socket's handshake is this module's callers' job, not this
// module's: `admitGuest` is already consumed by the query-string join path in `live.ts`; `admitOutput`'s
// own consumer — minting the tickets OUT-01 describes from the grant it returns — is a later task's to
// build.

import { joinAllowedFor } from '@holydeck/contracts/services';

import { CapabilityError, capabilityContext, tokenDigest } from './capabilities.js';
import { requestContext } from './context.js';
import { VIEW_GRANTS } from './live-protocol.js';
import { SERVICE_PERMISSIONS } from './services.js';

import type { OutputChannel } from '@holydeck/contracts/live';
import type { CapabilityStore } from './capabilities.js';
import type { LiveGrant } from './live-protocol.js';
import type { ServiceStore } from './services.js';

export type GuestJoinRefusal = 'capability' | 'state';

/** Carries why a join was refused, so a caller can answer a defect and a plain "not yet" differently. */
export class GuestJoinError extends Error {
  readonly kind: GuestJoinRefusal;

  constructor(kind: GuestJoinRefusal, message: string) {
    super(message);
    this.name = 'GuestJoinError';
    this.kind = kind;
  }
}

export interface GuestJoinRequest {
  readonly token: string;
  readonly service: string;
  readonly view: OutputChannel;
}

/** The system-acting, read-only context a join checks a Service's lifecycle state under. Nobody signed
 *  in for this — an anonymous Guest has no session to read one from — so it is never the caller's own. */
const serviceReadContext = (correlationId: string): unknown =>
  requestContext({ actor: 'system', permissions: [SERVICE_PERMISSIONS.read], correlationId });

/**
 * Admits a Guest to one output channel, or refuses — never anything in between, and never anything
 * short of both gates above. `correlationId` is the caller's own, so a refusal traces back through the
 * same log line whichever gate stopped it.
 */
export async function admitGuest(
  capabilities: CapabilityStore,
  services: ServiceStore,
  correlationId: string,
  request: GuestJoinRequest,
): Promise<LiveGrant> {
  let redeemed;
  try {
    redeemed = await capabilities.redeem(capabilityContext(correlationId), request.token, {
      service: request.service,
      view: request.view,
    });
  } catch (error: unknown) {
    if (error instanceof CapabilityError) throw new GuestJoinError('capability', error.message);
    throw error;
  }
  if (redeemed.kind !== 'guest') {
    throw new GuestJoinError('capability', 'capabilities: that capability does not open a Guest join');
  }
  const record = await services.current(serviceReadContext(correlationId), request.service);
  if (record === undefined || !joinAllowedFor(record.state)) {
    throw new GuestJoinError(
      'state',
      `${request.service} is not Presenting, and a Guest capability opens only while its Service is`,
    );
  }
  return { ...VIEW_GRANTS[redeemed.view], capabilityId: tokenDigest(request.token) };
}

export interface OutputJoinRequest {
  readonly token: string;
  readonly service: string;
  readonly view: OutputChannel;
}

/**
 * Admits an output window to one channel, or refuses — the same capability check `admitGuest` makes,
 * without the second, Presenting-only gate: an output window opens on its capability alone (OUT-02).
 */
export async function admitOutput(
  capabilities: CapabilityStore,
  correlationId: string,
  request: OutputJoinRequest,
): Promise<LiveGrant> {
  let redeemed;
  try {
    redeemed = await capabilities.redeem(capabilityContext(correlationId), request.token, {
      service: request.service,
      view: request.view,
    });
  } catch (error: unknown) {
    if (error instanceof CapabilityError) throw new GuestJoinError('capability', error.message);
    throw error;
  }
  if (redeemed.kind !== 'output') {
    throw new GuestJoinError('capability', 'capabilities: that capability does not open an output window');
  }
  return { ...VIEW_GRANTS[redeemed.view], capabilityId: tokenDigest(request.token) };
}
