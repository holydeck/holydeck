// Where a third-party integration's status is read and its enabled switch is changed (spec v1c-09, ADMN-04).
// Shaped like settings-routes.ts: one permission, INTEGRATIONS_MANAGE, gates both routes, and a deployment
// with nowhere to keep an identity serves the same paths answering not-found — nothing here to audit a
// change against. Enabling is never unconditional: sermon-ai (spec v1c-08) has nothing to call without a
// configured Anthropic credential (settings.ts's own anthropicApiKey field comment), so a request to
// enable it is honored only when anthropicApiKey is set, silently clamped back to false otherwise.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { parseIntegrationPatch } from '@holydeck/contracts/integrations';

import { auditContext } from './audit.js';
import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { INTEGRATIONS_MANAGE } from './roles.js';

import type { RouteNeed } from './authorization.js';
import type { Identity } from './onboarding.js';
import type { SettingsAdmin } from './settings-admin.js';
import type { Settings } from './settings.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const INTEGRATION_PREFIX = 'integration:';

export const INTEGRATIONS_PATH = '/api/v1/integrations';
export const INTEGRATION_ID_PATH = '/api/v1/integrations/:id';

const PERMISSION: RouteNeed = { kind: 'permission', need: INTEGRATIONS_MANAGE };

const ROUTES = [
  ['GET', INTEGRATIONS_PATH],
  ['PATCH', INTEGRATION_ID_PATH],
] as const;

const KNOWN_INTEGRATION_IDS = ['sermon-ai'] as const;
type IntegrationId = (typeof KNOWN_INTEGRATION_IDS)[number];

function statusOf(id: IntegrationId, settings: Settings) {
  const configured = settings.anthropicApiKey !== '';
  return {
    id,
    configured,
    enabled: settings.sermonAiEnabled && configured,
    lastCallAt: null as string | null,
    callsInLast30Days: 0,
  };
}

export interface IntegrationRoutesOptions {
  readonly settingsAdmin: SettingsAdmin | undefined;
  readonly identity: Identity | undefined;
}

export function serveIntegrationRoutes(app: FastifyInstance, { settingsAdmin, identity }: IntegrationRoutesOptions): void {
  if (identity === undefined) {
    for (const [method, url] of ROUTES) {
      app.route({ method, url, config: { need: PERMISSION }, handler: (request, reply) => reply.code(404).send(notFound(request)) });
    }
    return;
  }

  const admin = settingsAdmin as SettingsAdmin;

  const note = async (request: FastifyRequest, actor: string, id: string, detail: string): Promise<void> => {
    try {
      await identity.audit.record(auditContext(actor, correlationFor(INTEGRATION_PREFIX, request.id)), {
        action: 'integration.disable',
        subject: id,
        outcome: 'allowed',
        detail,
      });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the integration trail refused an entry');
    }
  };

  app.get(INTEGRATIONS_PATH, { config: { need: PERMISSION } }, (request) => {
    const list = KNOWN_INTEGRATION_IDS.map((id) => statusOf(id, admin.current().values));
    return successEnvelope(list, request.id, CLIENT_WINDOW.current);
  });

  app.patch(INTEGRATION_ID_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!KNOWN_INTEGRATION_IDS.includes(id as IntegrationId)) return reply.code(404).send(notFound(request));

    const parsed = parseIntegrationPatch(request.body, 'body');
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));

    const settings = admin.current().values;
    const enabled = parsed.value.enabled && settings.anthropicApiKey !== '';
    const updated = await admin.update({ sermonAiEnabled: enabled });

    const actor = provenSession(request).record.actor;
    await note(request, actor, id, enabled ? 'enabled' : 'disabled');

    return reply.send(successEnvelope(statusOf(id as IntegrationId, updated.values), request.id, CLIENT_WINDOW.current));
  });
}
