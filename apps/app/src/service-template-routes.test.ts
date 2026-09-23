import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, VALIDATION_FAILED } from '@holydeck/contracts/http';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { FORBIDDEN, guardMutations, mutatingRoutesOf } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { passkeysOn } from './passkeys.js';
import { SERVICES_MANAGE, SERVICE_TEMPLATES_MANAGE, SETTINGS_MANAGE } from './roles.js';
import {
  SERVICE_TEMPLATE_FROM_SERVICE_PATH,
  SERVICE_TEMPLATE_ID_PATH,
  SERVICE_TEMPLATE_INSTANTIATE_PATH,
  SERVICE_TEMPLATE_PATH,
  SERVICE_TEMPLATE_REVISIONS_PATH,
  SERVICE_TEMPLATE_STATUS_PATH,
  serveServiceTemplateRoutes,
} from './service-template-routes.js';
import { serviceTemplatesOn } from './service-templates.js';
import { ServiceError, serviceContext, servicesOn } from './services.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { ServiceTemplateBody, ServiceTemplateDraft, TemplateInstantiation } from '@holydeck/contracts/service-templates';
import type { Identity } from './onboarding.js';
import type { Document } from './repositories.js';
import type { ServiceStore } from './services.js';
import type { ServiceTemplateStore } from './service-templates.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance } from 'fastify';

const START = Date.parse('2026-09-22T09:30:00.000Z');
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const CORRELATION = 'req-0f9c2a41';
const ADMINISTRATOR = 'account:' + 'C'.repeat(22);

const BODY: ServiceTemplateBody = {
  sections: [
    {
      id: 'welcome',
      name: 'Welcome',
      entries: [{ id: 'opener', slot: 'fixed', itemKind: 'custom-slide', title: 'Welcome slide', content: undefined }],
    },
  ],
};

const OTHER_BODY: ServiceTemplateBody = { sections: [] };

const DRAFT: ServiceTemplateDraft = { name: 'Sunday service', body: BODY };
const WIRE_DRAFT = { name: DRAFT.name, ...DRAFT.body };
const WIRE_BODY = { name: DRAFT.name, ...BODY };
const WIRE_OTHER_BODY = { name: DRAFT.name, ...OTHER_BODY };

const SERVICE_DRAFT = {
  title: 'Sunday Gathering',
  date: '2026-09-20',
  site: 'main',
  sections: [
    {
      id: 'welcome',
      name: 'Welcome',
      items: [{ id: 'opener', kind: 'custom-slide' as const, title: 'Welcome slide', enabled: true, content: undefined }],
    },
  ],
};

// A blank left for the caller to fill, alongside the fixed slide every instantiation carries unchanged.
const INSTANTIATION_BODY: ServiceTemplateBody = {
  sections: [
    {
      id: 'welcome',
      name: 'Welcome',
      entries: [
        { id: 'opener', slot: 'fixed', itemKind: 'custom-slide', title: 'Welcome slide', content: undefined },
        { id: 'response', slot: 'typed', itemKind: 'custom-slide', required: true },
      ],
    },
  ],
};
const WIRE_INSTANTIATION_DRAFT = { name: 'Sunday service', ...INSTANTIATION_BODY };
const INSTANTIATION: TemplateInstantiation = {
  title: 'Sunday Morning',
  date: '2026-09-27',
  site: 'Main Hall',
  fills: [{ entryId: 'response', title: 'Response', content: undefined }],
};

let app: FastifyInstance;
let sessions: SessionStore;
let db: FakeDb;
let identity: Identity;
let templates: ServiceTemplateStore;
let services: ServiceStore;
let admin: StartedSession;
let tick: number;

const now = (): string => new Date(START + (tick += 1) * 1000 - 1000).toISOString();

const entries = (): Document[] => db.rows.get('audit_events') ?? [];

const actions = (): unknown[] => entries().map((entry) => entry['action']);

const withHeaders = (held: StartedSession = admin) => ({
  [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
  host: HOST,
  'x-forwarded-proto': 'https',
  origin: ORIGIN,
  cookie: sessionCookie(held.token, 60),
  [CSRF_HEADER]: held.record.csrf,
});

const creating = (payload: unknown, held: StartedSession = admin) =>
  app.inject({ method: 'POST', url: SERVICE_TEMPLATE_PATH, headers: withHeaders(held), payload: payload as never });

const at = (path: string, id: string): string => path.replace(':id', id);

const previewing = (id: string, query = '', held: StartedSession = admin) =>
  app.inject({ method: 'GET', url: `${at(SERVICE_TEMPLATE_ID_PATH, id)}${query}`, headers: withHeaders(held) });

const versioning = (id: string, payload: unknown, held: StartedSession = admin) =>
  app.inject({ method: 'PUT', url: at(SERVICE_TEMPLATE_ID_PATH, id), headers: withHeaders(held), payload: payload as never });

const statusing = (id: string, payload: unknown, held: StartedSession = admin) =>
  app.inject({ method: 'PATCH', url: at(SERVICE_TEMPLATE_STATUS_PATH, id), headers: withHeaders(held), payload: payload as never });

const listing = (id: string, held: StartedSession = admin) =>
  app.inject({ method: 'GET', url: at(SERVICE_TEMPLATE_REVISIONS_PATH, id), headers: withHeaders(held) });

const listTemplates = (held: StartedSession = admin) =>
  app.inject({ method: 'GET', url: SERVICE_TEMPLATE_PATH, headers: withHeaders(held) });

const fromService = (serviceId: string, payload: unknown, held: StartedSession = admin) =>
  app.inject({
    method: 'POST',
    url: SERVICE_TEMPLATE_FROM_SERVICE_PATH.replace(':serviceId', serviceId),
    headers: withHeaders(held),
    payload: payload as never,
  });

const instantiating = (id: string, payload: unknown, held: StartedSession = admin) =>
  app.inject({ method: 'POST', url: at(SERVICE_TEMPLATE_INSTANTIATE_PATH, id), headers: withHeaders(held), payload: payload as never });

/** One Service Template, created through the surface, so every test below starts from a real stamp. */
const created = async (payload: unknown = WIRE_DRAFT): Promise<string> => {
  const response = await creating(payload);
  return response.json().data.stamp.id as string;
};

// `store` has no default: an explicit `undefined` argument would otherwise be indistinguishable from an
// omitted one and silently fall back to `templates`, defeating the one test below that needs it absent.
// `heldServices` is the same story for the Service store the instantiate route reaches into.
const serving = async (
  held: Identity | undefined,
  store: ServiceTemplateStore | undefined,
  heldServices: ServiceStore | undefined,
): Promise<void> => {
  app = Fastify({ logger: false });
  withSafeErrors(app);
  guardMutations(app, { sessions });
  enforceAuthorization(app, { sessions, identity: undefined });
  serveServiceTemplateRoutes(app, { serviceTemplates: store, identity: held, services: heldServices });
  await app.ready();
};

beforeEach(async () => {
  tick = 0;
  db = fakeDb();
  sessions = sessionsOn(memorySessions().db, { now: () => new Date(START).toISOString() });
  identity = {
    accounts: accountsOn(memoryAccounts().db, {
      now,
      newId: () => 'A'.repeat(22),
      hash: async (password) => `test-hash:${password}`,
      verify: async (password, stored) => stored === `test-hash:${password}`,
    }),
    audit: auditOn(db, { now, newId: () => `e${entries().length}` }),
    attempts: attemptsOn(memoryAttempts().db, { now }),
    totp: totpsOn(memoryTotp().db, { now }),
    passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
  let serial = 0;
  services = servicesOn(db, { now, newId: () => `service-${(serial += 1)}` });
  templates = serviceTemplatesOn(db, { now, newId: () => `template-${(serial += 1)}`, services });
  await serving(identity, templates, services);
  admin = await sessions.start(sessionContext(CORRELATION), {
    actor: ADMINISTRATOR,
    permissions: [SERVICE_TEMPLATES_MANAGE, SERVICES_MANAGE],
  });
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

describe('creating a Service Template', () => {
  test('answers the stamp it was given, the first revision, and the entries it holds', async () => {
    const response = await creating(WIRE_DRAFT);
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      name: 'Sunday service',
      revision: 1,
      stamp: { id: 'template-1', kind: 'serviceTemplate' },
    });
    expect(response.json().data.stamp.archivedAt).toBeUndefined();
    expect(response.json().data.body).toEqual(BODY);
  });

  test('refuses a draft that is not a Service Template', async () => {
    const response = await creating({ name: '', sections: [] });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
  });

  test('writes nothing at all for a draft it refused', async () => {
    await creating({ name: '', sections: [] });
    expect(db.rows.get('service_templates') ?? []).toEqual([]);
    expect(db.rows.get('content_revisions') ?? []).toEqual([]);
  });

  test('records the creation in the trail, against the Template and never a bare identifier', async () => {
    const id = await created();
    expect(actions()).toEqual(['content.change']);
    expect(entries()[0]).toMatchObject({ actor: ADMINISTRATOR, subject: `serviceTemplate:${id}` });
  });

  test('refuses a creation that lost the race for the identifier it was given', async () => {
    await app.close();
    templates = serviceTemplatesOn(db, { now, newId: () => 'template-twice', services });
    await serving(identity, templates, services);
    expect((await creating(WIRE_DRAFT)).statusCode).toBe(201);
    const second = await creating({ name: 'Evening service', sections: [] });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe(ENTITY_CONFLICT);
    const standing = await previewing('template-twice');
    expect(standing.json().data).toMatchObject({ name: 'Sunday service', revision: 1 });
    expect(standing.json().data.body).toEqual(BODY);
  });

  test('a trail that refuses an entry does not cost the Template', async () => {
    await app.close();
    await serving(
      { ...identity, audit: { record: () => Promise.reject(new Error('the trail is unavailable')) } },
      templates,
      services,
    );
    expect((await creating(WIRE_DRAFT)).statusCode).toBe(201);
  });
});

describe('previewing a Service Template', () => {
  test('answers the standing entries without writing anything', async () => {
    const id = await created();
    const before = (db.rows.get('service_templates') ?? []).length;
    const response = await previewing(id);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.body).toEqual(BODY);
    expect((db.rows.get('service_templates') ?? []).length).toBe(before);
    expect(actions()).toEqual(['content.change']);
  });

  test('answers an earlier ordinal when one is asked for by name', async () => {
    const id = await created();
    await versioning(id, WIRE_OTHER_BODY);
    expect((await previewing(id)).json().data.revision).toBe(2);
    const first = await previewing(id, '?revision=1');
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({ revision: 1 });
    expect(first.json().data.body).toEqual(BODY);
  });

  test('answers not-found for a Template nobody created, and for an ordinal it never had', async () => {
    const id = await created();
    expect((await previewing('template-99')).statusCode).toBe(404);
    expect((await previewing(id, '?revision=9')).statusCode).toBe(404);
  });

  test('refuses an ordinal that is not one, rather than reading it as the first', async () => {
    const id = await created();
    const response = await previewing(id, '?revision=first');
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields[0].path).toBe('revision');
  });
});

describe('saving a Service Template forward', () => {
  test('appends the next ordinal, and a later preview reads it back', async () => {
    const id = await created();
    const response = await versioning(id, WIRE_OTHER_BODY);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ appended: true, renamed: false, revision: 2 });
    expect((await previewing(id)).json().data.body).toEqual(OTHER_BODY);
  });

  test('appends nothing when the entries did not change, and says so', async () => {
    const id = await created();
    const response = await versioning(id, WIRE_BODY);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ appended: false, renamed: false, revision: 1 });
    expect(actions()).toEqual(['content.change']);
  });

  test('saves a new name even when the entries did not change, and audits the rename', async () => {
    const id = await created();
    const response = await versioning(id, { ...WIRE_BODY, name: 'Sunday service v2' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ appended: false, renamed: true, revision: 1 });
    expect((await previewing(id)).json().data.name).toBe('Sunday service v2');
    expect(actions()).toEqual(['content.change', 'serviceTemplate.version']);
    expect(entries()[1]).toMatchObject({ subject: `serviceTemplate:${id}`, detail: 'renamed' });
  });

  test('records one entry per ordinal it appended, naming the ordinal', async () => {
    const id = await created();
    await versioning(id, WIRE_OTHER_BODY);
    expect(actions()).toEqual(['content.change', 'serviceTemplate.version']);
    expect(entries()[1]).toMatchObject({ subject: `serviceTemplate:${id}`, detail: 'saved revision 2' });
  });

  test('refuses entries that are not entries, and answers not-found for a Template nobody created', async () => {
    const id = await created();
    expect(
      (await versioning(id, { name: 'Sunday service', sections: [{ id: 's', name: 'S', entries: [{ id: 'x' }] }] }))
        .statusCode,
    ).toBe(422);
    expect((await versioning('template-99', WIRE_BODY)).statusCode).toBe(404);
  });

  test('refuses to change an archived Template, which is what archiving one means', async () => {
    const id = await created();
    await statusing(id, { archived: true });
    const response = await versioning(id, WIRE_OTHER_BODY);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(ENTITY_CONFLICT);
  });
});

describe('archiving a Service Template and bringing it back', () => {
  test('stops offering it, leaving its entries exactly where they were', async () => {
    const id = await created();
    const response = await statusing(id, { archived: true });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.stamp.archivedBy).toBe(ADMINISTRATOR);
    expect((await previewing(id)).json().data.body).toEqual(BODY);
  });

  test('brings it back, and a Template that was never archived cannot be brought back', async () => {
    const id = await created();
    expect((await statusing(id, { archived: false })).statusCode).toBe(409);
    await statusing(id, { archived: true });
    const restored = await statusing(id, { archived: false });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().data.stamp.archivedAt).toBeUndefined();
  });

  test('refuses to archive one that is already archived', async () => {
    const id = await created();
    await statusing(id, { archived: true });
    const again = await statusing(id, { archived: true });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe(ENTITY_CONFLICT);
  });

  test('refuses a body that says nothing about being archived, and a Template nobody created', async () => {
    const id = await created();
    expect((await statusing(id, { hidden: true })).statusCode).toBe(422);
    expect((await statusing('template-99', { archived: true })).statusCode).toBe(404);
  });

  test('records which direction it went, so the trail says it without a body to read', async () => {
    const id = await created();
    await statusing(id, { archived: true });
    await statusing(id, { archived: false });
    expect(entries().map((entry) => entry['detail'])).toEqual(['created', 'archived', 'brought back']);
    expect(actions()).toEqual(['content.change', 'serviceTemplate.archive', 'serviceTemplate.unarchive']);
  });
});

describe('listing Service Templates', () => {
  test('lets an Editor holding only services.manage list but not create, preview, save or archive', async () => {
    const id = await created();
    const editor = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [SERVICES_MANAGE] });
    const listed = await listTemplates(editor);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data).toMatchObject([{ name: 'Sunday service' }]);
    expect((await creating(WIRE_DRAFT, editor)).statusCode).toBe(403);
    expect((await previewing(id, '', editor)).statusCode).toBe(403);
    expect((await versioning(id, WIRE_OTHER_BODY, editor)).statusCode).toBe(403);
    expect((await statusing(id, { archived: true }, editor)).statusCode).toBe(403);
  });

  test('gates every route from a session with neither permission before calling the store', async () => {
    const guest = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [SETTINGS_MANAGE] });
    expect((await creating(WIRE_DRAFT, guest)).statusCode).toBe(403);
    expect((await listTemplates(guest)).statusCode).toBe(403);
  });
});

describe('the history a Service Template keeps', () => {
  test('lists every ordinal and how it came to exist, and never the entries themselves', async () => {
    const id = await created();
    await versioning(id, WIRE_OTHER_BODY);
    const response = await listing(id);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.revisions).toEqual([
      { revision: 1, at: expect.any(String), actor: ADMINISTRATOR, origin: 'manual-checkpoint' },
      { revision: 2, at: expect.any(String), actor: ADMINISTRATOR, origin: 'manual-checkpoint' },
    ]);
    expect(response.body).not.toContain('opener');
  });

  test('answers not-found for a Template nobody created', async () => {
    expect((await listing('template-99')).statusCode).toBe(404);
  });
});

describe('minting a Service Template from a Service', () => {
  test('converts an existing Service into a new Template, and records the conversion', async () => {
    const service = await services.create(serviceContext(ADMINISTRATOR, CORRELATION), SERVICE_DRAFT);
    const response = await fromService(service.stamp.id, { name: 'From Sunday Gathering' });
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({ name: 'From Sunday Gathering', revision: 1 });
    expect(response.json().data.body.sections[0].entries[0]).toMatchObject({ id: 'opener', slot: 'fixed' });
    expect(entries()).toContainEqual(
      expect.objectContaining({
        action: 'serviceTemplate.fromService',
        subject: `serviceTemplate:${response.json().data.stamp.id}`,
        detail: `converted from ${service.stamp.id}`,
      }),
    );
  });

  test('rejects a blank name before calling the store', async () => {
    const service = await services.create(serviceContext(ADMINISTRATOR, CORRELATION), SERVICE_DRAFT);
    const response = await fromService(service.stamp.id, { name: '' });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
  });

  test('answers not-found for a Service nobody created', async () => {
    const response = await fromService('service-404', { name: 'Anything' });
    expect(response.statusCode).toBe(404);
  });
});

describe('instantiating a Service from a Service Template', () => {
  test('fills typed entries and copies fixed ones into a new Service', async () => {
    const id = await created(WIRE_INSTANTIATION_DRAFT);
    const response = await instantiating(id, INSTANTIATION);
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({ title: INSTANTIATION.title, date: INSTANTIATION.date, site: INSTANTIATION.site });
    expect(response.json().data.sections[0].items).toMatchObject([
      { id: 'opener', title: 'Welcome slide' },
      { id: 'response', title: 'Response' },
    ]);
  });

  test('refuses a required typed entry left unfilled', async () => {
    const id = await created(WIRE_INSTANTIATION_DRAFT);
    const response = await instantiating(id, { ...INSTANTIATION, fills: [] });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields?.[0]).toMatchObject({ path: 'fills.response', code: 'field.required' });
  });

  test('answers not-found for a Template nobody created', async () => {
    expect((await instantiating('template-99', INSTANTIATION)).statusCode).toBe(404);
  });

  test('lets an Editor holding only services.manage instantiate, though not manage Templates', async () => {
    const id = await created(WIRE_INSTANTIATION_DRAFT);
    const editor = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [SERVICES_MANAGE] });
    expect((await instantiating(id, INSTANTIATION, editor)).statusCode).toBe(201);
  });

  test('refuses instantiation from a session without services.manage', async () => {
    const id = await created(WIRE_INSTANTIATION_DRAFT);
    const guest = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [SETTINGS_MANAGE] });
    expect((await instantiating(id, INSTANTIATION, guest)).statusCode).toBe(403);
  });

  test('answers not-found when no Service store is configured, even with Templates configured', async () => {
    const id = await created(WIRE_INSTANTIATION_DRAFT);
    await app.close();
    await serving(identity, templates, undefined);
    expect((await instantiating(id, INSTANTIATION)).statusCode).toBe(404);
  });

  test('maps a schema refusal from the Service it creates to 422, and any other refusal to 409', async () => {
    const id = await created(WIRE_INSTANTIATION_DRAFT);
    const create = vi.spyOn(services, 'create');
    create.mockRejectedValueOnce(new ServiceError('schema', 'this is not a Service'));
    expect((await instantiating(id, INSTANTIATION)).statusCode).toBe(422);
    create.mockRejectedValueOnce(new ServiceError('conflict', 'competing write'));
    const response = await instantiating(id, INSTANTIATION);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(ENTITY_CONFLICT);
  });
});

describe('who may ask any of it', () => {
  test('every route that changes a Template is behind the guard, and the three that read are not', () => {
    expect(mutatingRoutesOf(app)).toEqual([
      { method: 'POST', url: SERVICE_TEMPLATE_PATH },
      { method: 'PUT', url: SERVICE_TEMPLATE_ID_PATH },
      { method: 'PATCH', url: SERVICE_TEMPLATE_STATUS_PATH },
      { method: 'POST', url: SERVICE_TEMPLATE_FROM_SERVICE_PATH },
      { method: 'POST', url: SERVICE_TEMPLATE_INSTANTIATE_PATH },
    ]);
  });

  test('refuses a request that carries no session at all', async () => {
    const response = await app.inject({
      method: 'GET',
      url: at(SERVICE_TEMPLATE_ID_PATH, 'template-1'),
      headers: { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current), host: HOST, origin: ORIGIN },
    });
    expect(response.statusCode).toBe(401);
  });

  test('refuses a session that was never granted the permission, for every mutating route here', async () => {
    const id = await created();
    const guest = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [] });
    const refused = [
      await creating(WIRE_DRAFT, guest),
      await versioning(id, WIRE_OTHER_BODY, guest),
      await statusing(id, { archived: true }, guest),
      await fromService('service-1', { name: 'Anything' }, guest),
    ];
    for (const response of refused) {
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe(FORBIDDEN);
    }
  });
});

describe('what this surface refuses to answer at all', () => {
  test('a deployment that keeps neither serves every path, and answers not-found from each', async () => {
    await app.close();
    await serving(undefined, undefined, undefined);
    expect((await creating(WIRE_DRAFT)).statusCode).toBe(404);
    expect((await listTemplates())).toHaveProperty('statusCode', 404);
    expect((await previewing('template-1')).statusCode).toBe(404);
    expect((await listing('template-1')).statusCode).toBe(404);
    expect((await versioning('template-1', WIRE_OTHER_BODY)).statusCode).toBe(404);
    expect((await statusing('template-1', { archived: true })).statusCode).toBe(404);
    expect((await fromService('service-1', { name: 'Anything' })).statusCode).toBe(404);
    expect((await instantiating('template-1', INSTANTIATION)).statusCode).toBe(404);
  });

  test('answers not-found from the identity gate alone, even with a store configured', async () => {
    await app.close();
    await serving(undefined, templates, services);
    expect((await creating(WIRE_DRAFT)).statusCode).toBe(404);
    expect((await listTemplates())).toHaveProperty('statusCode', 404);
    expect((await previewing('template-1')).statusCode).toBe(404);
  });

  test('answers not-found from the store gate alone, even with an identity configured', async () => {
    await app.close();
    await serving(identity, undefined, services);
    expect((await creating(WIRE_DRAFT)).statusCode).toBe(404);
    expect((await listTemplates())).toHaveProperty('statusCode', 404);
    expect((await previewing('template-1')).statusCode).toBe(404);
  });
});
