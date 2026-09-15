// Where a Guest's invitation and an output window's capability are issued, and where either is revoked.
//
// Requirement IDEN-08: granting either is Control presentation's alone, the same permission `roles.ts`
// gates every other operator surface behind. A guest invitation never carries a `view` the caller chose —
// the route hardcodes it to the audience view, so nothing above the store has to be trusted to have left
// the field out. An output capability's `view` is the one choice its route accepts.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { VALIDATION_FAILED, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { type Parsed, parseObject } from '@holydeck/contracts/problems';

import { auditContext } from './audit.js';
import { CapabilityError, capabilityContext } from './capabilities.js';
import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { PRESENTATION_CONTROL } from './roles.js';

import type { AuditAction, AuditOutcome } from './audit.js';
import type { CapabilityStore, CapabilityView } from './capabilities.js';
import type { RouteNeed } from './authorization.js';
import type { Identity } from './onboarding.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const CAPABILITY_PREFIX = 'capability:';

export const GUEST_INVITATION_PATH = '/api/v1/live/guest-invitation';

export const OUTPUT_CAPABILITY_PATH = '/api/v1/live/output-capability';

export const CAPABILITIES_PATH = '/api/v1/live/capabilities';

const REVOKE_PATH = `${CAPABILITIES_PATH}/:capabilityId`;

const PERMISSION: RouteNeed = { kind: 'permission', need: PRESENTATION_CONTROL };

/** Every route this module serves, in the order it registers them, and what each of them changes. */
const ROUTES = [
  ['POST', GUEST_INVITATION_PATH],
  ['POST', OUTPUT_CAPABILITY_PATH],
  ['DELETE', REVOKE_PATH],
] as const;

interface GuestInvitationBody {
  readonly service: string;
  readonly expiresAt: string;
}

interface OutputCapabilityBody {
  readonly service: string;
  readonly view: CapabilityView;
  readonly expiresAt: string;
}

const parseGuestInvitationBody = (value: unknown): Parsed<GuestInvitationBody> =>
  parseObject(value, 'guestInvitation', (reader) => ({
    service: reader.text('service'),
    expiresAt: reader.time('expiresAt'),
  }));

const parseOutputCapabilityBody = (value: unknown): Parsed<OutputCapabilityBody> =>
  parseObject(value, 'outputCapability', (reader) => ({
    service: reader.text('service'),
    view: reader.choice('view', ['audience', 'stage'] as const),
    expiresAt: reader.time('expiresAt'),
  }));

export interface CapabilityRoutesOptions {
  /** Absent in a deployment that keeps no capabilities, which has nothing here to issue or revoke. */
  readonly capabilities: CapabilityStore | undefined;
  /** Absent audit-writing is best-effort everywhere else in this server, and this surface is no different. */
  readonly identity: Identity | undefined;
}

export function serveCapabilityRoutes(app: FastifyInstance, { capabilities, identity }: CapabilityRoutesOptions): void {
  // A deployment with nowhere to keep a capability has nothing here to grant or revoke. Every path is
  // still served, so the guard's table remains the complete shape of the surface in every deployment.
  if (capabilities === undefined) {
    for (const [method, url] of ROUTES) {
      app.route({
        method,
        url,
        config: { need: PERMISSION },
        handler: (request, reply) => reply.code(404).send(notFound(request)),
      });
    }
    return;
  }

  /**
   * Written after the change, and logged rather than answered when the trail refuses it: a capability that
   * was issued or revoked holds that, whether or not this server managed to write it down.
   */
  const note = async (
    request: FastifyRequest,
    actor: string,
    outcome: AuditOutcome,
    action: AuditAction,
    detail: string,
  ): Promise<void> => {
    if (identity === undefined) return;
    try {
      await identity.audit.record(auditContext(actor, correlationFor(CAPABILITY_PREFIX, request.id)), {
        action,
        subject: actor,
        outcome,
        detail,
      });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the capability trail refused an entry');
    }
  };

  app.post(GUEST_INVITATION_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseGuestInvitationBody(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const operator = provenSession(request).record.actor;
    const call = capabilityContext(correlationFor(CAPABILITY_PREFIX, request.id));
    try {
      const issued = await capabilities.issue(call, operator, {
        kind: 'guest',
        service: parsed.value.service,
        view: 'audience',
        expiresAt: parsed.value.expiresAt,
      });
      await note(
        request,
        operator,
        'allowed',
        'capability.guest.issue',
        `a guest invitation was issued for service ${parsed.value.service}, expiring ${parsed.value.expiresAt}`,
      );
      return reply.code(201).send(
        successEnvelope(
          {
            token: issued.token,
            capabilityId: issued.capabilityId,
            kind: 'guest' as const,
            service: parsed.value.service,
            view: 'audience' as const,
            expiresAt: parsed.value.expiresAt,
          },
          request.id,
          CLIENT_WINDOW.current,
        ),
      );
    } catch (error) {
      if (error instanceof CapabilityError && error.kind === 'schema') {
        return reply
          .code(422)
          .send(validationFailure(request.id, [{ path: 'expiresAt', code: VALIDATION_FAILED, message: error.message }]));
      }
      throw error;
    }
  });

  app.post(OUTPUT_CAPABILITY_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseOutputCapabilityBody(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const operator = provenSession(request).record.actor;
    const call = capabilityContext(correlationFor(CAPABILITY_PREFIX, request.id));
    try {
      const issued = await capabilities.issue(call, operator, {
        kind: 'output',
        service: parsed.value.service,
        view: parsed.value.view,
        expiresAt: parsed.value.expiresAt,
      });
      await note(
        request,
        operator,
        'allowed',
        'capability.output.issue',
        `an output capability was issued for service ${parsed.value.service}, ${parsed.value.view} view, expiring ${parsed.value.expiresAt}`,
      );
      return reply.code(201).send(
        successEnvelope(
          {
            token: issued.token,
            capabilityId: issued.capabilityId,
            kind: 'output' as const,
            service: parsed.value.service,
            view: parsed.value.view,
            expiresAt: parsed.value.expiresAt,
          },
          request.id,
          CLIENT_WINDOW.current,
        ),
      );
    } catch (error) {
      if (error instanceof CapabilityError && error.kind === 'schema') {
        return reply
          .code(422)
          .send(validationFailure(request.id, [{ path: 'expiresAt', code: VALIDATION_FAILED, message: error.message }]));
      }
      throw error;
    }
  });

  app.delete(REVOKE_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const { capabilityId } = request.params as { readonly capabilityId: string };
    const operator = provenSession(request).record.actor;
    await capabilities.revoke(capabilityContext(correlationFor(CAPABILITY_PREFIX, request.id)), capabilityId);
    await note(request, operator, 'allowed', 'capability.revoke', `capability ${capabilityId} was revoked`);
    return reply.send(successEnvelope({ revoked: true }, request.id, CLIENT_WINDOW.current));
  });
}
