import { actorFor } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, VALIDATION_FAILED } from '@holydeck/contracts/http';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { buildApp } from './app.js';
import { SERVICES_MANAGE, SERVICE_TEMPLATES_MANAGE, SETTINGS_MANAGE } from './roles.js';
import { SERVICE_TEMPLATE_ID_PATH, SERVICE_TEMPLATE_PATH } from './service-template-routes.js';
import { ServiceTemplateError, serviceTemplateContext, serviceTemplatesOn } from './service-templates.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { loadSettings } from './settings.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memorySessions } from '../test/helpers/sessions.js';

import type { ServiceTemplateDraft } from '@holydeck/contracts/service-templates';
import type { ServiceTemplateStore } from './service-templates.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FastifyInstance } from 'fastify';

const NOW = '2026-09-22T09:30:00.000Z';
const OPERATOR = actorFor('C'.repeat(22));
const CORRELATION = 'req-0f9c2a41';
const DRAFT: ServiceTemplateDraft = {
  name: 'Sunday service',
  body: {
    sections: [{
      id: 'section-1', name: 'Welcome', entries: [
        { id: 'entry-1', slot: 'fixed', itemKind: 'custom-slide', title: 'Welcome', content: undefined },
      ],
    }],
  },
};
const WIRE_DRAFT = { name: DRAFT.name, ...DRAFT.body };
const templatePath = (id: string): string => SERVICE_TEMPLATE_ID_PATH.replace(':id', id);

let app: FastifyInstance;
let templates: ServiceTemplateStore;
let sessions: SessionStore;
let operator: StartedSession;

const building = async (serviceTemplates: ServiceTemplateStore | undefined): Promise<void> => {
  app = buildApp({
    settings: loadSettings({ env: {} }),
    logger: false,
    fetching: () => Promise.reject(new Error('this route must not ask the corpus')),
    sessions,
    ...(serviceTemplates === undefined ? {} : { serviceTemplates }),
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

beforeEach(async () => {
  let serial = 0;
  templates = serviceTemplatesOn(fakeDb(), { now: () => NOW, newId: () => `template-${++serial}` });
  sessions = sessionsOn(memorySessions().db, { now: () => NOW });
  operator = await sessions.start(sessionContext(CORRELATION), {
    actor: OPERATOR,
    permissions: [SERVICE_TEMPLATES_MANAGE, SERVICES_MANAGE],
  });
  await building(templates);
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

describe('Service Template routes', () => {
  test('creates and previews a Service Template with the request context', async () => {
    const create = vi.spyOn(templates, 'create');
    const created = await asking('POST', SERVICE_TEMPLATE_PATH, WIRE_DRAFT);
    expect(created.statusCode).toBe(201);
    expect(created.json().data).toMatchObject({ id: 'template-1', name: DRAFT.name, revision: 1, createdBy: OPERATOR });
    expect(create).toHaveBeenCalledWith(
      serviceTemplateContext(OPERATOR, `serviceTemplate:${created.json().meta.requestId}`),
      DRAFT,
    );
    const previewed = await asking('GET', templatePath('template-1'));
    expect(previewed.statusCode).toBe(200);
    expect(previewed.json().data).toEqual(created.json().data);
  });

  test('lists every Service Template on file', async () => {
    await asking('POST', SERVICE_TEMPLATE_PATH, WIRE_DRAFT);
    const listed = await asking('GET', SERVICE_TEMPLATE_PATH);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data).toMatchObject([{ id: 'template-1', name: DRAFT.name }]);
  });

  test('lets an Editor holding only services.manage list but not create or preview Templates', async () => {
    const editor = await sessions.start(sessionContext(CORRELATION), { actor: OPERATOR, permissions: [SERVICES_MANAGE] });
    await asking('POST', SERVICE_TEMPLATE_PATH, WIRE_DRAFT);
    const listed = await asking('GET', SERVICE_TEMPLATE_PATH, undefined, editor);
    expect(listed.statusCode).toBe(200);
    const create = vi.spyOn(templates, 'create');
    const preview = vi.spyOn(templates, 'preview');
    expect((await asking('POST', SERVICE_TEMPLATE_PATH, WIRE_DRAFT, editor)).statusCode).toBe(403);
    expect((await asking('GET', templatePath('template-1'), undefined, editor)).statusCode).toBe(403);
    expect(create).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  test('gates every route from an editor session before calling the store', async () => {
    const editor = await sessions.start(sessionContext(CORRELATION), { actor: OPERATOR, permissions: [SETTINGS_MANAGE] });
    const create = vi.spyOn(templates, 'create');
    const preview = vi.spyOn(templates, 'preview');
    const list = vi.spyOn(templates, 'list');
    expect((await asking('POST', SERVICE_TEMPLATE_PATH, WIRE_DRAFT, editor)).statusCode).toBe(403);
    expect((await asking('GET', templatePath('template-1'), undefined, editor)).statusCode).toBe(403);
    expect((await asking('GET', SERVICE_TEMPLATE_PATH, undefined, editor)).statusCode).toBe(403);
    expect(create).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  test('returns 404 when a Service Template was never created', async () => {
    expect((await asking('GET', templatePath('unknown'))).statusCode).toBe(404);
  });

  test('maps a template conflict to 409', async () => {
    vi.spyOn(templates, 'create').mockRejectedValue(new ServiceTemplateError('conflict', 'competing write'));
    const response = await asking('POST', SERVICE_TEMPLATE_PATH, WIRE_DRAFT);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(ENTITY_CONFLICT);
  });

  test('rejects an invalid draft before calling the store', async () => {
    const create = vi.spyOn(templates, 'create');
    const response = await asking('POST', SERVICE_TEMPLATE_PATH, {});
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(create).not.toHaveBeenCalled();
  });

  test.each([
    ['POST', SERVICE_TEMPLATE_PATH, WIRE_DRAFT],
    ['GET', templatePath('template-1'), undefined],
    ['GET', SERVICE_TEMPLATE_PATH, undefined],
  ] as const)('serves a gated 404 fallback for %s %s without a store', async (method, url, payload) => {
    await app.close();
    await building(undefined);
    const response = await asking(method, url, payload);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('resource.not_found');
  });
});
