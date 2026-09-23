// Where the settings file is read back, and where a change to it is asked for.
//
// Shaped like `accounts-routes.ts`: one permission, `SETTINGS_MANAGE`, gates both routes, and a deployment
// with nowhere to keep an identity serves the same two paths answering not-found — the same gate
// `accounts-routes.ts` uses, and for the same reason: nothing to audit a change against. `main.ts` never
// constructs a `settingsAdmin` without an `identity` alongside it either (both come from the same
// `mongoUrl !== ''` block), so this one gate covers both. Reading the file is never audited, the same as
// any other GET; writing it is, exactly once per request that succeeds, and the entry names which fields
// changed and never what they changed to — the trail is not a second place a secret could leak from.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { FIELD_CODES, isRecord } from '@holydeck/contracts/problems';

import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { redactorFor, secretsIn } from './redaction.js';
import { SETTINGS_MANAGE } from './roles.js';
import { DEFAULT_SETTINGS, ENV_KEYS, SettingsError } from './settings.js';

import type { AuditAction, AuditOutcome } from './audit.js';
import type { RouteNeed } from './authorization.js';
import type { Identity } from './onboarding.js';
import type { SettingsAdmin } from './settings-admin.js';
import type { Settings } from './settings.js';
import type { Problem } from '@holydeck/contracts/problems';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const SETTINGS_PREFIX = 'settings:';

export const SETTINGS_PATH = '/api/v1/settings';

const PERMISSION: RouteNeed = { kind: 'permission', need: SETTINGS_MANAGE };

/** Every route this module serves, in the order it registers them. */
const ROUTES = [
  ['GET', SETTINGS_PATH],
  ['PATCH', SETTINGS_PATH],
] as const;

export interface SettingsRoutesOptions {
  /** Absent whenever `identity` is, per `main.ts`'s wiring — never independently, from this module's view. */
  readonly settingsAdmin: SettingsAdmin | undefined;
  /** Absent in a deployment that keeps no identity, which has nothing here to audit a change against. */
  readonly identity: Identity | undefined;
}

/**
 * The one setting a loader problem is about, read off the name it starts with — a setting's own name for
 * a value from the file or this request, its environment variable for one from the deployment. A problem
 * naming two settings at once ("tlsCertFile and tlsKeyFile: ...") belongs to neither input alone, and
 * neither does one this cannot place, so both answer undefined and stay on the form as a whole.
 */
const settingNamed = (problem: string): string | undefined => {
  const name = problem.slice(0, Math.max(0, problem.indexOf(':')));
  if (name in DEFAULT_SETTINGS) return name;
  return Object.entries(ENV_KEYS).find(([, variable]) => variable === name)?.[0];
};

export function serveSettingsRoutes(app: FastifyInstance, { settingsAdmin, identity }: SettingsRoutesOptions): void {
  // A deployment with nowhere to keep an identity has nothing here to audit a change against. Every path
  // is still served, so the guard's table remains the complete shape of the surface in every deployment.
  if (identity === undefined) {
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

  // Guaranteed by `main.ts`'s wiring, not by this module: an `identity` never exists without a
  // `settingsAdmin` alongside it, so the gate above is this module's only check for either.
  const admin = settingsAdmin as SettingsAdmin;

  /**
   * Written after the change, and logged rather than answered when the trail refuses it: a settings change
   * holds that it happened, whether or not this server managed to write it down.
   */
  const note = async (
    request: FastifyRequest,
    action: AuditAction,
    actor: string,
    outcome: AuditOutcome,
    detail: string,
  ): Promise<void> => {
    try {
      await identity.audit.record(auditContext(actor, correlationFor(SETTINGS_PREFIX, request.id)), {
        action,
        subject: 'settings',
        outcome,
        detail,
      });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the settings trail refused an entry');
    }
  };

  app.get(SETTINGS_PATH, { config: { need: PERMISSION } }, (request) => {
    const loaded = admin.current();
    const redact = redactorFor(secretsIn(loaded.values));
    return successEnvelope(
      {
        values: redact(loaded.values) as Settings,
        sources: loaded.sources,
        lastReloadError: admin.lastReloadError(),
      },
      request.id,
      CLIENT_WINDOW.current,
    );
  });

  app.patch(SETTINGS_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    if (!isRecord(request.body)) {
      return reply.code(422).send(
        validationFailure(request.id, [{ path: 'settings', code: FIELD_CODES.notAnObject, message: 'must be an object' }]),
      );
    }
    const operator = provenSession(request).record.actor;
    try {
      const updated = await admin.update(request.body as Partial<Settings>);
      const changed = Object.keys(request.body).sort().join(', ');
      await note(request, 'settings.update', operator, 'allowed', `changed ${changed}`);
      const redact = redactorFor(secretsIn(updated.values));
      return reply.send(
        successEnvelope(
          { values: redact(updated.values) as Settings, sources: updated.sources, lastReloadError: admin.lastReloadError() },
          request.id,
          CLIENT_WINDOW.current,
        ),
      );
    } catch (error) {
      if (error instanceof SettingsError) {
        const problems: Problem[] = error.problems.map((problem) => {
          const setting = settingNamed(problem);
          return {
            path: setting === undefined ? 'settings' : `settings.${setting}`,
            code: FIELD_CODES.notAllowed,
            message: problem,
          };
        });
        return reply.code(422).send(validationFailure(request.id, problems));
      }
      throw error;
    }
  });
}
