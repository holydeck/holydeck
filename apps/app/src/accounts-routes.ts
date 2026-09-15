// The surface Control presentation is granted to an account, or taken back from one.
//
// Requirement IDEN-06: this is the first route this server asks a permission of, rather than merely a
// proved session, and the shape every later route that administers something follows: a need declared
// once, through `config.need`, and checked once, before a handler runs at all. Granting the control is
// Admin's alone, by the operator-facing vocabulary `roles.ts` names — never by holding it already.

import { ACCOUNTS_PATH, actorFor, parseControlGrant } from '@holydeck/contracts/accounts';
import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { successEnvelope, validationFailure } from '@holydeck/contracts/http';

import { accountContext } from './accounts.js';
import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { ACCOUNTS_MANAGE } from './roles.js';

import type { AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { Identity } from './onboarding.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const ACCOUNT_PREFIX = 'account:';

/** Where one account is granted or refused Control presentation, apart from the three roles. */
const CONTROL_PATH = `${ACCOUNTS_PATH}/:id/control-presentation`;

const PERMISSION: RouteNeed = { kind: 'permission', need: ACCOUNTS_MANAGE };

export interface AccountRoutesOptions {
  /** Absent in a deployment that keeps no accounts, which has nothing here to administer. */
  readonly identity: Identity | undefined;
}

export function serveAccountRoutes(app: FastifyInstance, { identity }: AccountRoutesOptions): void {
  // A deployment with nowhere to keep an account has nothing here to grant or revoke. The path is still
  // served, so the guard's table remains the complete shape of the surface in every deployment.
  if (identity === undefined) {
    app.route({
      method: 'PATCH',
      url: CONTROL_PATH,
      config: { need: PERMISSION },
      handler: (request, reply) => reply.code(404).send(notFound(request)),
    });
    return;
  }

  /**
   * Written after the change, and logged rather than answered when the trail refuses it: an account that
   * was granted or refused Control presentation holds that, whether or not this server managed to write it.
   */
  const note = async (request: FastifyRequest, actor: string, subject: string, outcome: AuditOutcome): Promise<void> => {
    try {
      await identity.audit.record(auditContext(actor, correlationFor(ACCOUNT_PREFIX, request.id)), {
        action: 'account.control',
        subject,
        outcome,
      });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the account trail refused an entry');
    }
  };

  app.patch(CONTROL_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const parsed = parseControlGrant(request.body);
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));
    const id = (request.params as { readonly id: string }).id;
    const updated = await identity.accounts.grantControl(
      accountContext(correlationFor(ACCOUNT_PREFIX, request.id)),
      id,
      parsed.value.granted,
    );
    // Nothing an id nobody holds could have been granted or refused: this answers the lookup that failed,
    // not a decision about Control presentation, so it is not one the trail has anything to say about.
    if (updated === undefined) return reply.code(404).send(notFound(request));
    await note(request, provenSession(request).record.actor, actorFor(id), 'allowed');
    return reply.send(successEnvelope(updated, request.id, CLIENT_WINDOW.current));
  });
}
