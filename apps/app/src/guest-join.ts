// Admitting an anonymous Guest to the Audience view (spec LIVE-03, 9.3, 9.5), and nothing else this
// module could be mistaken for. Two things gate a join, both read live and neither cached: the
// capability itself — T32's `capabilities.ts`, redeemed exactly as an output window's is, against the
// service and view the caller names — and the Service that capability names, which a Guest may only
// reach while ADR 0002 has it Presenting (`joinAllowedFor`, T44). A capability that redeems clean against
// a Service in any of the other three states is still refused: the capability outliving the one window
// it was scoped to is not this module's failure to catch, `capabilities.ts`'s expiry is, and this is the
// second, independent gate spec 9.3 asks for on top of it.
//
// What redeeming answers with carries no identity at all (`RedeemedCapability`'s `guest` arm), and
// nothing here adds one: a Guest's `LiveGrant` names a view to watch, never who is watching it — spec
// 9.5's whole privacy contract is kept by there being no field here for a name, an email or an account to
// go in, not by a promise to leave one blank.
//
// An output capability redeems through the same store and the same shape, but is refused here: this door
// is a Guest's alone, and consuming an output window's capability through the live socket is a later
// task's to build.

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
