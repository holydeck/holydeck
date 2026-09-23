// Where a third-party integration's status is read and its enabled switch is changed (spec v1c-09, ADMN-04).
// Shaped like settings-routes.ts: one permission, INTEGRATIONS_MANAGE, gates both routes, and a deployment
// with nowhere to keep an identity serves the same paths answering not-found — nothing here to audit a
// change against. Enabling is never unconditional: sermon-ai (spec v1c-08) has nothing to call without a
// configured Anthropic credential (settings.ts's own anthropicApiKey field comment), so a request to
// enable it without one is refused as a validation problem rather than quietly clamped back to false.
// A switch the environment holds is refused the same way a read-only settings field is: writing it to a
// file the loader would then ignore changes nothing while answering as if it had. The last call and the
// 30-day count are read back out of the audit trail's integration.call rows, which are the only record
// of a call this product keeps.

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope, validationFailure } from '@holydeck/contracts/http';
import { parseIntegrationPatch } from '@holydeck/contracts/integrations';
import { FIELD_CODES } from '@holydeck/contracts/problems';

import { auditContext, auditReadContext } from './audit.js';
import { correlationFor } from './context.js';
import { provenSession } from './csrf.js';
import { notFound } from './failures.js';
import { INTEGRATIONS_MANAGE } from './roles.js';
import { SettingsError } from './settings.js';

import type { RouteNeed } from './authorization.js';
import type { Identity } from './onboarding.js';
import type { SettingsAdmin } from './settings-admin.js';
import type { AuditTrail } from './audit.js';
import type { LoadedSettings, Settings } from './settings.js';
import type { Problem } from '@holydeck/contracts/problems';
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

const DAY_MS = 86_400_000;
const CALL_WINDOW_DAYS = 30;
/** The trail's own page ceiling; the count walks pages of it rather than asking for one unbounded read. */
const PAGE = 100;

interface CallHistory {
  readonly lastCallAt: string | null;
  readonly callsInLast30Days: number;
}

/** Newest first, so the first row read is the last call, and the walk stops at the window's edge. */
async function callHistory(trail: AuditTrail, context: unknown, since: string): Promise<CallHistory> {
  const query = { action: 'integration.call' as const, from: since, limit: PAGE };
  let page = await trail.list(context, query);
  const lastCallAt = page.entries[0]?.at ?? null;
  let calls = page.entries.length;
  while (page.nextCursor !== undefined) {
    page = await trail.list(context, { ...query, cursor: page.nextCursor });
    calls += page.entries.length;
  }
  // The window only bounds the count: a call older than it is still the last call when nothing is newer.
  if (lastCallAt !== null) return { lastCallAt, callsInLast30Days: calls };
  const [older] = (await trail.list(context, { action: 'integration.call', limit: 1 })).entries;
  return { lastCallAt: older?.at ?? null, callsInLast30Days: 0 };
}

/** What the sermon-AI route needs to know before it calls anything: which key, and whether it may. */
export interface SermonAiSwitch {
  /** Empty when there is no resolver to call at all, which is not the same thing as one switched off. */
  readonly apiKey: string;
  readonly enabled: boolean;
}

/**
 * The key comes from settings first and the bare ANTHROPIC_API_KEY the sermon routes shipped reading
 * second, so a deployment configured either way shows as configured here and is switched by this page.
 */
export function sermonAiSwitch(settings: Settings, bareApiKey: string | undefined): SermonAiSwitch {
  const apiKey = settings.anthropicApiKey !== '' ? settings.anthropicApiKey : (bareApiKey ?? '');
  return { apiKey, enabled: settings.sermonAiEnabled && apiKey !== '' };
}

function statusOf(id: IntegrationId, loaded: LoadedSettings, history: CallHistory, bareApiKey: string | undefined) {
  const { apiKey, enabled } = sermonAiSwitch(loaded.values, bareApiKey);
  return {
    id,
    configured: apiKey !== '',
    enabled,
    ...history,
    lockedByEnvironment: loaded.sources.sermonAiEnabled === 'env',
  };
}

export interface IntegrationRoutesOptions {
  readonly settingsAdmin: SettingsAdmin | undefined;
  readonly identity: Identity | undefined;
  /** Where the 30-day window ends. Injected so a test pins it; production reads the wall clock. */
  readonly clock?: () => Date;
  /** The bare ANTHROPIC_API_KEY, when the deployment gave one outside the settings file. */
  readonly anthropicApiKey?: string | undefined;
}

export function serveIntegrationRoutes(
  app: FastifyInstance,
  { settingsAdmin, identity, clock = () => new Date(), anthropicApiKey }: IntegrationRoutesOptions,
): void {
  if (identity === undefined) {
    for (const [method, url] of ROUTES) {
      app.route({ method, url, config: { need: PERMISSION }, handler: (request, reply) => reply.code(404).send(notFound(request)) });
    }
    return;
  }

  const admin = settingsAdmin as SettingsAdmin;

  const note = async (request: FastifyRequest, actor: string, id: string, enabled: boolean): Promise<void> => {
    try {
      await identity.audit.record(auditContext(actor, correlationFor(INTEGRATION_PREFIX, request.id)), {
        action: enabled ? 'integration.enable' : 'integration.disable',
        subject: id,
        outcome: 'allowed',
        detail: enabled ? 'enabled' : 'disabled',
      });
    } catch (error: unknown) {
      request.log.error({ err: error }, 'the integration trail refused an entry');
    }
  };

  const historyFor = (request: FastifyRequest): Promise<CallHistory> =>
    callHistory(
      identity.audit,
      auditReadContext(provenSession(request).record.actor, correlationFor(INTEGRATION_PREFIX, request.id)),
      new Date(clock().getTime() - CALL_WINDOW_DAYS * DAY_MS).toISOString(),
    );

  app.get(INTEGRATIONS_PATH, { config: { need: PERMISSION } }, async (request) => {
    const history = await historyFor(request);
    const list = KNOWN_INTEGRATION_IDS.map((id) => statusOf(id, admin.current(), history, anthropicApiKey));
    return successEnvelope(list, request.id, CLIENT_WINDOW.current);
  });

  app.patch(INTEGRATION_ID_PATH, { config: { need: PERMISSION } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!KNOWN_INTEGRATION_IDS.includes(id as IntegrationId)) return reply.code(404).send(notFound(request));

    const parsed = parseIntegrationPatch(request.body, 'body');
    if (!parsed.ok) return reply.code(422).send(validationFailure(request.id, parsed.problems));

    const { enabled } = parsed.value;
    const standing = admin.current();
    if (standing.sources.sermonAiEnabled === 'env') {
      const message = 'this switch is set by the deployment environment and cannot be changed here';
      return reply.code(409).send(errorEnvelope(ENTITY_CONFLICT, message, request.id));
    }
    if (enabled && sermonAiSwitch(standing.values, anthropicApiKey).apiKey === '') {
      const problem: Problem = {
        path: 'enabled',
        code: FIELD_CODES.notAllowed,
        message: 'needs an Anthropic API key in settings before it can be enabled',
      };
      return reply.code(422).send(validationFailure(request.id, [problem]));
    }

    let updated: LoadedSettings;
    try {
      updated = await admin.update({ sermonAiEnabled: enabled });
    } catch (error) {
      if (!(error instanceof SettingsError)) throw error;
      const problems = error.problems.map((message): Problem => ({ path: 'settings', code: FIELD_CODES.notAllowed, message }));
      return reply.code(422).send(validationFailure(request.id, problems));
    }

    await note(request, provenSession(request).record.actor, id, enabled);

    const status = statusOf(id as IntegrationId, updated, await historyFor(request), anthropicApiKey);
    return reply.send(successEnvelope(status, request.id, CLIENT_WINDOW.current));
  });
}
