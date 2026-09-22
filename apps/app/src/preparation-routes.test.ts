import { actorFor } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, VALIDATION_FAILED } from '@holydeck/contracts/http';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { buildApp } from './app.js';
import {
  PREPARATION_OVERRIDE_PATH,
  PREPARATION_PREPARED_PATH,
  PREPARATION_PREPARE_PATH,
  PREPARATION_READINESS_PATH,
} from './preparation-routes.js';
import { PRESENTATION_CONTROL, SERVICES_MANAGE } from './roles.js';
import { serviceContext, servicesOn } from './services.js';
import { PreparationError, preparationContext, preparationOn } from './snapshots.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { loadSettings } from './settings.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memorySessions } from '../test/helpers/sessions.js';

import type { ServiceDraft } from '@holydeck/contracts/services';
import type { PreparationInputs, PreparationStore, ReadinessObservation } from './snapshots.js';
import type { ServiceStore } from './services.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FastifyInstance } from 'fastify';

const NOW = '2026-09-22T09:30:00.000Z';
const OPERATOR = actorFor('C'.repeat(22));
const CORRELATION = 'req-0f9c2a41';
const DRAFT: ServiceDraft = {
  title: 'Sunday service', date: '2026-09-22', site: 'Main Hall', sections: [{
    id: 'section-1', name: 'Welcome', items: [
      { id: 'item-1', kind: 'custom-slide', title: 'Welcome', enabled: true, content: undefined },
    ],
  }],
};
const INPUTS: PreparationInputs = {
  slideLayout: { id: 'layout-1', revision: 3 },
  serviceTemplate: 'template-1@2',
  settings: 'settings@41',
  media: 'media@2026-09-21',
  corpus: 'corpus@2026-09-01',
  aspectRatio: '16:9',
};
const OBSERVED: ReadinessObservation = {
  checks: [{
    name: 'Media: one file missing', group: 'Media', severity: 'blocker', cause: 'welcome.mp4 is not in the media store',
  }],
};
const servicePath = (path: string, id: string): string => path.replace(':id', id);

let app: FastifyInstance;
let services: ServiceStore;
let preparation: PreparationStore;
let routed: PreparationStore;
let sessions: SessionStore;
let operator: StartedSession;

const building = async (store: PreparationStore | undefined): Promise<void> => {
  app = buildApp({
    settings: loadSettings({ env: {} }),
    logger: false,
    fetching: () => Promise.reject(new Error('this route must not ask the corpus')),
    sessions,
    services,
    ...(store === undefined ? {} : { preparation: store }),
  });
  await app.ready();
};

const asking = (method: 'GET' | 'POST', url: string, payload?: unknown, held: StartedSession = operator) =>
  app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as never }),
    headers: {
      [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
      host: 'holydeck.example.invalid',
      'x-forwarded-proto': 'https',
      origin: 'https://holydeck.example.invalid',
      cookie: sessionCookie(held.token, 60),
      [CSRF_HEADER]: held.record.csrf,
    },
  });

const service = async (): Promise<string> =>
  (await services.create(serviceContext(OPERATOR, CORRELATION), DRAFT)).stamp.id;

beforeEach(async () => {
  let serial = 0;
  const db = fakeDb();
  services = servicesOn(db, { now: () => NOW, newId: () => `service-${++serial}` });
  preparation = preparationOn(db, { now: () => NOW, newId: () => `audit-${++serial}`, observe: () => OBSERVED });
  routed = {
    prepare: (context, id, inputs) => preparation.prepare(context, id, inputs),
    prepared: (context, id) => preparation.prepared(context, id),
    readiness: (context, id, observed) => preparation.readiness(context, id, observed),
    override: (session, request) => preparation.override(session, request),
    runLabel: (context, id) => preparation.runLabel(context, id),
  };
  sessions = sessionsOn(memorySessions().db, { now: () => NOW });
  operator = await sessions.start(sessionContext(CORRELATION), {
    actor: OPERATOR,
    permissions: [SERVICES_MANAGE, PRESENTATION_CONTROL],
  });
  await building(routed);
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

describe('Preparation routes', () => {
  test('prepares a Service, then returns its manifest and readiness with the request context', async () => {
    const id = await service();
    const prepare = vi.spyOn(routed, 'prepare');
    const prepared = vi.spyOn(routed, 'prepared');
    const readiness = vi.spyOn(routed, 'readiness');
    const created = await asking('POST', servicePath(PREPARATION_PREPARE_PATH, id), INPUTS);
    expect(created.statusCode).toBe(200);
    expect(prepare).toHaveBeenCalledWith(
      preparationContext(OPERATOR, `prepare:${created.json().meta.requestId}`), id, INPUTS,
    );
    const manifest = await asking('GET', servicePath(PREPARATION_PREPARED_PATH, id));
    expect(manifest.statusCode).toBe(200);
    expect(prepared).toHaveBeenCalledWith(
      preparationContext(OPERATOR, `prepared:${manifest.json().meta.requestId}`), id,
    );
    const checklist = await asking('GET', servicePath(PREPARATION_READINESS_PATH, id));
    expect(checklist.statusCode).toBe(200);
    expect(readiness).toHaveBeenCalledWith(
      preparationContext(OPERATOR, `readiness:${checklist.json().meta.requestId}`), id,
    );
  });

  test('overrides a prepared Service with an Operator session', async () => {
    const id = await service();
    await asking('POST', servicePath(PREPARATION_PREPARE_PATH, id), INPUTS);
    const override = vi.spyOn(routed, 'override');
    const response = await asking('POST', servicePath(PREPARATION_OVERRIDE_PATH, id), {
      runId: 'run-1', reason: 'The backup projector is on standby',
    });
    expect(response.statusCode).toBe(200);
    expect(override).toHaveBeenCalledWith({
      actor: OPERATOR,
      permissions: [SERVICES_MANAGE, PRESENTATION_CONTROL],
      correlationId: `override:${response.json().meta.requestId}`,
    }, { serviceId: id, runId: 'run-1', reason: 'The backup projector is on standby' });
  });

  // Readiness is this deployment's observation when the route has no observation to offer: the browser
  // asks for the checklist, while the configured observer is what knows the missing media is still open.
  test('reports a configured readiness blocker when the caller supplies no observation', async () => {
    const id = await service();
    await asking('POST', servicePath(PREPARATION_PREPARE_PATH, id), INPUTS);

    const response = await asking('GET', servicePath(PREPARATION_READINESS_PATH, id));

    expect(response.statusCode).toBe(200);
    expect(response.json().data.state).toBe('blocked');
    expect(response.json().data.blockers).toEqual(OBSERVED.checks);
  });

  test('gates the three preparation routes from a session without Services manage', async () => {
    const id = await service();
    const refused = await sessions.start(sessionContext(CORRELATION), { actor: OPERATOR, permissions: [PRESENTATION_CONTROL] });
    const prepare = vi.spyOn(routed, 'prepare');
    const prepared = vi.spyOn(routed, 'prepared');
    const readiness = vi.spyOn(routed, 'readiness');
    expect((await asking('POST', servicePath(PREPARATION_PREPARE_PATH, id), INPUTS, refused)).statusCode).toBe(403);
    expect((await asking('GET', servicePath(PREPARATION_PREPARED_PATH, id), undefined, refused)).statusCode).toBe(403);
    expect((await asking('GET', servicePath(PREPARATION_READINESS_PATH, id), undefined, refused)).statusCode).toBe(403);
    expect(prepare).not.toHaveBeenCalled();
    expect(prepared).not.toHaveBeenCalled();
    expect(readiness).not.toHaveBeenCalled();
  });

  test('gates override from an Admin permission set without Control presentation', async () => {
    const id = await service();
    const admin = await sessions.start(sessionContext(CORRELATION), { actor: OPERATOR, permissions: [SERVICES_MANAGE] });
    const override = vi.spyOn(routed, 'override');
    expect((await asking('POST', servicePath(PREPARATION_OVERRIDE_PATH, id), { runId: 'run-1', reason: 'Fallback ready' }, admin)).statusCode)
      .toBe(403);
    expect(override).not.toHaveBeenCalled();
  });

  test.each([
    ['POST', PREPARATION_PREPARE_PATH, INPUTS],
    ['GET', PREPARATION_PREPARED_PATH, undefined],
    ['GET', PREPARATION_READINESS_PATH, undefined],
  ] as const)('returns 404 when %s %s has no Service', async (method, path, payload) => {
    expect((await asking(method, servicePath(path, 'unknown'), payload)).statusCode).toBe(404);
  });

  test('maps an override without a prepared manifest to 409', async () => {
    const id = await service();
    const response = await asking('POST', servicePath(PREPARATION_OVERRIDE_PATH, id), {
      runId: 'run-1', reason: 'Fallback ready',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(ENTITY_CONFLICT);
  });

  test('rejects malformed preparation inputs before calling the store', async () => {
    const prepare = vi.spyOn(routed, 'prepare');
    const response = await asking('POST', servicePath(PREPARATION_PREPARE_PATH, 'unknown'), {});
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(prepare).not.toHaveBeenCalled();
  });

  test.each([
    ['a key separator', 'run#1'],
    ['only whitespace', '   \t'],
    ['more than 64 characters', 'r'.repeat(65)],
  ])('rejects an override runId containing %s before calling the store', async (_what, runId) => {
    const override = vi.spyOn(routed, 'override');

    const response = await asking('POST', servicePath(PREPARATION_OVERRIDE_PATH, 'service-1'), {
      runId, reason: 'The backup projector is on standby',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(response.json().error.fields).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'runId' })]));
    expect(override).not.toHaveBeenCalled();
  });

  // Whitespace is text and therefore reaches the store: that boundary owns whether a reason is one a
  // person can read, while the route keeps its refusal in the validation envelope a client expects.
  test('maps the store-side override reason refusal to 422', async () => {
    const response = await asking('POST', servicePath(PREPARATION_OVERRIDE_PATH, 'service-1'), {
      runId: 'run-1', reason: '   ',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
  });

  test.each([
    ['schema', 422],
    ['conflict', 409],
  ] as const)('maps a store-side override %s refusal to %i', async (kind, status) => {
    vi.spyOn(routed, 'override').mockRejectedValueOnce(new PreparationError(kind, `the store refused ${kind}`));

    const response = await asking('POST', servicePath(PREPARATION_OVERRIDE_PATH, 'service-1'), {
      runId: 'run-1', reason: 'The backup projector is on standby',
    });

    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(status === 422 ? VALIDATION_FAILED : ENTITY_CONFLICT);
  });

  test.each([
    ['POST', PREPARATION_PREPARE_PATH, INPUTS],
    ['GET', PREPARATION_PREPARED_PATH, undefined],
    ['GET', PREPARATION_READINESS_PATH, undefined],
    ['POST', PREPARATION_OVERRIDE_PATH, { runId: 'run-1', reason: 'Fallback ready' }],
  ] as const)('serves a gated 404 fallback for %s %s without a store', async (method, path, payload) => {
    await app.close();
    await building(undefined);
    const response = await asking(method, servicePath(path, 'service-1'), payload);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('resource.not_found');
  });
});
