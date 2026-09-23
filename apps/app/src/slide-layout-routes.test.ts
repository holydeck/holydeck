import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, VALIDATION_FAILED } from '@holydeck/contracts/http';
import { SLIDE_LAYOUTS_PATH } from '@holydeck/contracts/layouts';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { FORBIDDEN, guardMutations, mutatingRoutesOf } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { passkeysOn } from './passkeys.js';
import { CONTENT_EDIT, LAYOUTS_MANAGE } from './roles.js';
import {
  LAYOUT_BOXES_PATH,
  LAYOUT_PATH,
  LAYOUT_REVISIONS_PATH,
  serveSlideLayoutRoutes,
} from './slide-layout-routes.js';
import { slideLayoutsOn } from './slide-layouts.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { Identity } from './onboarding.js';
import type { Document } from './repositories.js';
import type { SlideLayoutStore } from './slide-layouts.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance } from 'fastify';

const START = Date.parse('2026-09-13T09:30:00.000Z');
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const CORRELATION = 'req-0f9c2a41';
const ADMINISTRATOR = 'account:' + 'C'.repeat(22);

const text = {
  id: 'title',
  kind: 'text',
  frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.3 },
  importance: 'required',
  binding: { mode: 'keyed', contentKind: 'sermon', contentKey: 'title', languageKey: 'en' },
  style: {
    fontFamily: 'Inter',
    fontWeight: 600,
    sizeRatio: 0.12,
    lineHeight: 1.2,
    align: 'center',
    verticalAlign: 'center',
  },
};

const backdrop = {
  id: 'backdrop',
  kind: 'media',
  frame: { x: 0, y: 0, width: 1, height: 1 },
  importance: 'decoration',
  style: { fit: 'cover', opacity: 0.6 },
  placeholder: 'sermon-still.jpg',
};

const DRAFT = { name: 'Sermon point', boxes: [text] };

let app: FastifyInstance;
let sessions: SessionStore;
let db: FakeDb;
let identity: Identity;
let layouts: SlideLayoutStore;
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
  app.inject({ method: 'POST', url: SLIDE_LAYOUTS_PATH, headers: withHeaders(held), payload: payload as never });

const at = (path: string, id: string): string => path.replace(':id', id);

const previewing = (id: string, query = '', held: StartedSession = admin) =>
  app.inject({ method: 'GET', url: `${at(LAYOUT_PATH, id)}${query}`, headers: withHeaders(held) });

const versioning = (id: string, payload: unknown, held: StartedSession = admin) =>
  app.inject({ method: 'PUT', url: at(LAYOUT_BOXES_PATH, id), headers: withHeaders(held), payload: payload as never });

const statusing = (id: string, payload: unknown, held: StartedSession = admin) =>
  app.inject({
    method: 'PATCH',
    url: `${at(LAYOUT_PATH, id)}/status`,
    headers: withHeaders(held),
    payload: payload as never,
  });

const listing = (id: string, held: StartedSession = admin) =>
  app.inject({ method: 'GET', url: at(LAYOUT_REVISIONS_PATH, id), headers: withHeaders(held) });

const listLayouts = (query = '', held: StartedSession = admin) =>
  app.inject({ method: 'GET', url: `${SLIDE_LAYOUTS_PATH}${query}`, headers: withHeaders(held) });

const restoring = (id: string, revision: string, held: StartedSession = admin) =>
  app.inject({
    method: 'POST',
    url: `${at(LAYOUT_REVISIONS_PATH, id)}/${revision}`,
    headers: withHeaders(held),
    payload: {} as never,
  });

/** One Layout, created through the surface, so every test below starts from a real stamp and revision. */
const created = async (payload: unknown = DRAFT): Promise<string> => {
  const response = await creating(payload);
  return response.json().data.stamp.id as string;
};

const serving = async (held: Identity | undefined, store: SlideLayoutStore | undefined = layouts): Promise<void> => {
  app = Fastify({ logger: false });
  withSafeErrors(app);
  guardMutations(app, { sessions });
  enforceAuthorization(app, { sessions, identity: undefined });
  serveSlideLayoutRoutes(app, { slideLayouts: store, identity: held });
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
  layouts = slideLayoutsOn(db, { now, newId: () => `layout-${(serial += 1)}` });
  await serving(identity);
  admin = await sessions.start(sessionContext(CORRELATION), {
    actor: ADMINISTRATOR,
    permissions: [LAYOUTS_MANAGE],
  });
});

afterEach(async () => {
  await app.close();
});

describe('creating a Slide Layout', () => {
  test('answers the stamp it was given, the first revision, and the boxes it holds', async () => {
    const response = await creating(DRAFT);
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      name: 'Sermon point',
      revision: 1,
      stamp: { id: 'layout-1', kind: 'slideLayout' },
    });
    expect(response.json().data.stamp.archivedAt).toBeUndefined();
    expect(response.json().data.body.boxes).toEqual([text]);
  });

  test('refuses a box nobody placed, naming the side of the frame that is missing', async () => {
    const unpositioned = { ...text, frame: { x: 0.1, y: 0.1, width: 0.8 } };
    const response = await creating({ name: 'Sermon point', boxes: [unpositioned] });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(response.json().error.fields[0].path).toBe('layout.boxes.0.frame.height');
  });

  test('writes nothing at all for a draft it refused', async () => {
    await creating({ name: '', boxes: [] });
    expect(db.rows.get('slide_layouts') ?? []).toEqual([]);
    expect(db.rows.get('content_revisions') ?? []).toEqual([]);
  });

  test('records the creation in the trail, against the Layout and never a bare identifier', async () => {
    const id = await created();
    expect(actions()).toEqual(['content.change']);
    expect(entries()[0]).toMatchObject({ actor: ADMINISTRATOR, subject: `slideLayout:${id}` });
  });

  test('refuses a creation that lost the race for the identifier it was given', async () => {
    await app.close();
    layouts = slideLayoutsOn(db, { now, newId: () => 'layout-twice' });
    await serving(identity);
    expect((await creating(DRAFT)).statusCode).toBe(201);
    const second = await creating({ name: 'Another arrangement', boxes: [backdrop] });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe(ENTITY_CONFLICT);
    // A 409 says nothing of the loser's was written, so the Layout that won the identifier has to be
    // exactly what it was: its own boxes, its own name, and a history that did not grow.
    const standing = await previewing('layout-twice');
    expect(standing.json().data).toMatchObject({ name: 'Sermon point', revision: 1 });
    expect(standing.json().data.body.boxes).toEqual([text]);
    expect((await listing('layout-twice')).json().data.revisions).toHaveLength(1);
  });

  test('a trail that refuses an entry does not cost the Layout', async () => {
    await app.close();
    await serving({
      ...identity,
      audit: {
        record: () => Promise.reject(new Error('the trail is unavailable')),
        list: () => Promise.reject(new Error('the trail is unavailable')),
      },
    });
    expect((await creating(DRAFT)).statusCode).toBe(201);
  });
});

describe('previewing a Slide Layout', () => {
  test('answers the standing boxes without writing anything', async () => {
    const id = await created();
    const before = (db.rows.get('slide_layouts') ?? []).length;
    const response = await previewing(id);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.body.boxes).toEqual([text]);
    expect((db.rows.get('slide_layouts') ?? []).length).toBe(before);
    expect(actions()).toEqual(['content.change']);
  });

  test('answers an earlier ordinal when one is asked for by name', async () => {
    const id = await created();
    await versioning(id, { boxes: [text, backdrop] });
    expect((await previewing(id)).json().data.revision).toBe(2);
    const first = await previewing(id, '?revision=1');
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({ revision: 1 });
    expect(first.json().data.body.boxes).toEqual([text]);
  });

  test('answers not-found for a Layout nobody created, and for an ordinal it never had', async () => {
    const id = await created();
    expect((await previewing('layout-99')).statusCode).toBe(404);
    expect((await previewing(id, '?revision=9')).statusCode).toBe(404);
  });

  test('refuses an ordinal that is not one, rather than reading it as the first', async () => {
    const id = await created();
    const response = await previewing(id, '?revision=first');
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields[0].path).toBe('revision');
  });

  test('answers with this server’s own fault when the stamp it reads back is unreadable', async () => {
    const id = await created();
    const rows = db.rows.get('slide_layouts') ?? [];
    rows[0] = { ...rows[0], stamp: 'not a stamp' };
    const response = await previewing(id);
    expect(response.statusCode).toBe(500);
  });
});

describe('saving a Slide Layout forward', () => {
  test('appends the next ordinal, and a later preview reads it back', async () => {
    const id = await created();
    const response = await versioning(id, { boxes: [text, backdrop] });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ appended: true, revision: 2 });
    expect((await previewing(id)).json().data.body.boxes).toEqual([text, backdrop]);
  });

  test('appends nothing when the boxes did not change, and says so', async () => {
    const id = await created();
    const response = await versioning(id, { boxes: [{ ...text, frame: { ...text.frame } }] });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ appended: false, revision: 1 });
    expect(actions()).toEqual(['content.change']);
  });

  test('records one entry per ordinal it appended, naming the ordinal', async () => {
    const id = await created();
    await versioning(id, { boxes: [text, backdrop] });
    expect(actions()).toEqual(['content.change', 'content.change']);
    expect(entries()[1]).toMatchObject({ subject: `slideLayout:${id}`, detail: 'saved revision 2' });
  });

  test('refuses boxes that are not boxes, and answers not-found for a Layout nobody created', async () => {
    const id = await created();
    expect((await versioning(id, { boxes: [] })).statusCode).toBe(422);
    expect((await versioning('layout-99', { boxes: [text] })).statusCode).toBe(404);
  });

  test('refuses to change an archived Layout, which is what archiving one means', async () => {
    const id = await created();
    await statusing(id, { archived: true });
    const response = await versioning(id, { boxes: [text, backdrop] });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(ENTITY_CONFLICT);
  });

  test('answers with this server’s own fault when the stamp under it is unreadable', async () => {
    const id = await created();
    const rows = db.rows.get('slide_layouts') ?? [];
    rows[0] = { ...rows[0], stamp: 'not a stamp' };
    expect((await versioning(id, { boxes: [text, backdrop] })).statusCode).toBe(500);
  });
});

describe('archiving a Slide Layout and bringing it back', () => {
  test('stops offering it, leaving its boxes exactly where they were', async () => {
    const id = await created();
    const response = await statusing(id, { archived: true });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.stamp.archivedBy).toBe(ADMINISTRATOR);
    expect((await previewing(id)).json().data.body.boxes).toEqual([text]);
  });

  test('brings it back, and a Layout that was never archived cannot be brought back', async () => {
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

  test('refuses a body that says nothing about being archived, and a Layout nobody created', async () => {
    const id = await created();
    expect((await statusing(id, { hidden: true })).statusCode).toBe(422);
    expect((await statusing('layout-99', { archived: true })).statusCode).toBe(404);
  });

  test('records which direction it went, so the trail says it without a body to read', async () => {
    const id = await created();
    await statusing(id, { archived: true });
    await statusing(id, { archived: false });
    expect(entries().map((entry) => entry['detail'])).toEqual(['created', 'archived', 'brought back']);
  });
});

describe('listing Slide Layouts', () => {
  test('lists active layouts for a content editor and ignores archived=true', async () => {
    const id = await created();
    await statusing(id, { archived: true });
    const editor = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [CONTENT_EDIT] });
    const response = await listLayouts('?archived=true', editor);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
  });

  test('lets a layout manager include archived layouts only when asked', async () => {
    const active = await created();
    const archived = await created({ name: 'Archived layout', boxes: [backdrop] });
    await statusing(archived, { archived: true });
    expect((await listLayouts()).json().data.map((row: { stamp: { id: string } }) => row.stamp.id)).toEqual([active]);
    expect((await listLayouts('?archived=true')).json().data.map((row: { stamp: { id: string } }) => row.stamp.id)).toEqual([active, archived]);
  });
});

describe('the history a Slide Layout keeps', () => {
  test('lists every ordinal and how it came to exist, and never the boxes themselves', async () => {
    const id = await created();
    await versioning(id, { boxes: [text, backdrop] });
    const response = await listing(id);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.revisions).toEqual([
      { revision: 1, at: expect.any(String), actor: ADMINISTRATOR, origin: 'manual-checkpoint' },
      { revision: 2, at: expect.any(String), actor: ADMINISTRATOR, origin: 'manual-checkpoint' },
    ]);
    expect(response.body).not.toContain('backdrop');
  });

  test('answers not-found for a Layout nobody created', async () => {
    expect((await listing('layout-99')).statusCode).toBe(404);
  });

  test('restores an earlier ordinal by appending it again, never by rewriting it', async () => {
    const id = await created();
    await versioning(id, { boxes: [text, backdrop] });
    const before = (await listing(id)).json().data.revisions;

    const response = await restoring(id, '1');

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ appended: true, revision: 3, from: 1 });
    const after = (await listing(id)).json().data.revisions;
    expect(after.length).toBe(before.length + 1);
    expect(after.slice(0, before.length)).toEqual(before);
    expect((await previewing(id)).json().data.body.boxes).toEqual([text]);
  });

  test('records the restore against the ordinal it came from', async () => {
    const id = await created();
    await versioning(id, { boxes: [text, backdrop] });
    await restoring(id, '1');
    expect(entries()[2]).toMatchObject({ detail: 'restored revision 1 as revision 3' });
  });

  test('appends nothing when the ordinal asked for is the one that already stands', async () => {
    const id = await created();
    await versioning(id, { boxes: [text, backdrop] });
    const response = await restoring(id, '2');
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ appended: false, revision: 2, from: 2 });
    expect(actions()).toEqual(['content.change', 'content.change']);
  });

  test('refuses to restore an ordinal onto an archived Layout', async () => {
    const id = await created();
    await versioning(id, { boxes: [text, backdrop] });
    await statusing(id, { archived: true });
    const response = await restoring(id, '1');
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(ENTITY_CONFLICT);
  });

  test('answers not-found for an ordinal this Layout never had, and refuses one that is not an ordinal', async () => {
    const id = await created();
    expect((await restoring(id, '9')).statusCode).toBe(404);
    expect((await restoring('layout-99', '1')).statusCode).toBe(404);
    const refused = await restoring(id, 'first');
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.fields[0].path).toBe('revision');
  });
});

describe('who may ask any of it', () => {
  test('every route that changes a Layout is behind the guard, and the two that read are not', () => {
    expect(mutatingRoutesOf(app)).toEqual([
      { method: 'POST', url: SLIDE_LAYOUTS_PATH },
      { method: 'PUT', url: LAYOUT_BOXES_PATH },
      { method: 'POST', url: `${LAYOUT_REVISIONS_PATH}/:revision` },
      { method: 'PATCH', url: `${LAYOUT_PATH}/status` },
    ]);
  });

  test('refuses a request that carries no session at all', async () => {
    const response = await app.inject({
      method: 'GET',
      url: at(LAYOUT_PATH, 'layout-1'),
      headers: { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current), host: HOST, origin: ORIGIN },
    });
    expect(response.statusCode).toBe(401);
  });

  test('refuses a session that was never granted the Layouts, for every route here', async () => {
    const id = await created();
    const guest = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [] });
    const refused = [
      await creating(DRAFT, guest),
      await previewing(id, '', guest),
      await listing(id, guest),
      await versioning(id, { boxes: [text] }, guest),
      await restoring(id, '1', guest),
      await statusing(id, { archived: true }, guest),
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
    await serving(undefined, undefined);
    expect((await creating(DRAFT)).statusCode).toBe(404);
    expect((await listLayouts())).toHaveProperty('statusCode', 404);
    expect((await previewing('layout-1')).statusCode).toBe(404);
    expect((await listing('layout-1')).statusCode).toBe(404);
    expect((await versioning('layout-1', { boxes: [text] })).statusCode).toBe(404);
    expect((await restoring('layout-1', '1')).statusCode).toBe(404);
    expect((await statusing('layout-1', { archived: true })).statusCode).toBe(404);
  });

  test('answers not-found from the identity gate alone, even with a store configured', async () => {
    await app.close();
    await serving(undefined);
    expect((await creating(DRAFT)).statusCode).toBe(404);
    expect((await listLayouts())).toHaveProperty('statusCode', 404);
    expect((await previewing('layout-1')).statusCode).toBe(404);
  });
});
