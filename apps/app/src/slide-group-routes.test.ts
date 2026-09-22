import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { CONTENT_LANGUAGES } from '@holydeck/contracts/content-languages';
import { ENTITY_CONFLICT, VALIDATION_FAILED } from '@holydeck/contracts/http';
import { SLIDE_GROUPS_PATH } from '@holydeck/contracts/slide-groups';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { FORBIDDEN, guardMutations } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { passkeysOn } from './passkeys.js';
import { CONTENT_EDIT } from './roles.js';
import { SLIDE_GROUP_ID_PATH, SLIDE_PATH, serveSlideGroupRoutes } from './slide-group-routes.js';
import { slideGroupsOn } from './slide-groups.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { Identity } from './onboarding.js';
import type { SlideGroupStore } from './slide-groups.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { LanguageBlock, Slide, SlideGroupBody } from '@holydeck/contracts/slide-groups';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance } from 'fastify';

const START = Date.parse('2026-09-22T09:30:00.000Z');
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const CORRELATION = 'req-0f9c2a41';
const ADMINISTRATOR = `account:${'C'.repeat(22)}`;
const [TAMIL, ROMANIZED_TAMIL] = CONTENT_LANGUAGES;
const BLOCK_A: LanguageBlock = { id: 'block-1', languageKey: TAMIL!.key, text: 'Andru' };
const BLOCK_B: LanguageBlock = { id: 'block-2', languageKey: ROMANIZED_TAMIL!.key, text: 'Andru vandhu' };
const SLIDE_A: Slide = { id: 'slide-1', enabled: true, label: 'Welcome', languageBlocks: [BLOCK_A, BLOCK_B] };
const SLIDE_B: Slide = { id: 'slide-2', enabled: true, label: 'Verse', languageBlocks: [] };
const CUSTOM: SlideGroupBody = {
  mode: 'custom', enabled: true, slideLayoutId: 'layout-a', slides: [SLIDE_A, SLIDE_B],
};
const GENERATED: SlideGroupBody = {
  mode: 'generated', enabled: true, slideLayoutId: 'layout-a', slides: [SLIDE_A], generatedFrom: { songId: 'song-1' },
};

let app: FastifyInstance;
let sessions: SessionStore;
let identity: Identity;
let groups: SlideGroupStore;
let db: FakeDb;
let admin: StartedSession;
let tick: number;

const now = (): string => new Date(START + (tick += 1) * 1000 - 1000).toISOString();
const at = (path: string, id: string): string => path.replace(':id', id);
const slideAt = (path: string, id: string, slideId = SLIDE_A.id): string => at(path, id).replace(':slideId', slideId);
const blockAt = (path: string, id: string, slideId = SLIDE_A.id, blockId = BLOCK_A.id): string =>
  slideAt(path, id, slideId).replace(':blockId', blockId);
const headers = (held: StartedSession = admin) => ({
  [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current), host: HOST, 'x-forwarded-proto': 'https', origin: ORIGIN,
  cookie: sessionCookie(held.token, 60), [CSRF_HEADER]: held.record.csrf,
});
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const ask = (method: Method, url: string, payload?: unknown, held: StartedSession = admin) =>
  app.inject({ method, url, headers: headers(held), ...(payload === undefined ? {} : { payload: payload as never }) });
const create = (body: SlideGroupBody = CUSTOM) => ask('POST', SLIDE_GROUPS_PATH, { kind: 'slideGroup', title: 'Welcome sequence', body });
const created = async (body: SlideGroupBody = CUSTOM): Promise<string> => (await create(body)).json().data.stamp.id as string;

const serving = async (held: Identity | undefined, store: SlideGroupStore | undefined = groups): Promise<void> => {
  app = Fastify({ logger: false });
  withSafeErrors(app);
  guardMutations(app, { sessions });
  enforceAuthorization(app, { sessions, identity: undefined });
  serveSlideGroupRoutes(app, { slideGroups: store, identity: held });
  await app.ready();
};

beforeEach(async () => {
  tick = 0;
  db = fakeDb();
  sessions = sessionsOn(memorySessions().db, { now: () => new Date(START).toISOString() });
  identity = {
    accounts: accountsOn(memoryAccounts().db, { now, newId: () => 'A'.repeat(22), hash: async (password) => `test-hash:${password}`, verify: async (password, stored) => stored === `test-hash:${password}` }),
    audit: auditOn(db, { now, newId: () => 'audit' }),
    attempts: attemptsOn(memoryAttempts().db, { now }), totp: totpsOn(memoryTotp().db, { now }),
    passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
  let serial = 0;
  groups = slideGroupsOn(db, { now, newId: () => `group-${(serial += 1)}` });
  await serving(identity);
  admin = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [CONTENT_EDIT] });
});

afterEach(async () => app.close());

describe('slide group routes', () => {
  test('creates a slide group and refuses an invalid draft', async () => {
    expect((await create()).statusCode).toBe(201);
    const refused = await ask('POST', SLIDE_GROUPS_PATH, { kind: 'slideGroup', title: '', body: CUSTOM });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe(VALIDATION_FAILED);
  });

  test('reads a slide group and refuses one it does not have', async () => {
    const id = await created();
    expect((await ask('GET', at(SLIDE_GROUP_ID_PATH, id))).json().data.stamp.id).toBe(id);
    expect((await ask('GET', at(SLIDE_GROUP_ID_PATH, 'group-99'))).statusCode).toBe(404);
  });

  test('edits a custom slide group and refuses editing a generated group', async () => {
    const id = await created();
    expect((await ask('PUT', at(SLIDE_GROUP_ID_PATH, id), { ...CUSTOM, enabled: false })).statusCode).toBe(200);
    const generated = await created(GENERATED);
    const refused = await ask('PUT', at(SLIDE_GROUP_ID_PATH, generated), CUSTOM);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe(ENTITY_CONFLICT);
  });

  test('duplicates a slide group and refuses one it does not have', async () => {
    const id = await created();
    expect((await ask('POST', `${at(SLIDE_GROUP_ID_PATH, id)}/duplicate`)).statusCode).toBe(201);
    expect((await ask('POST', `${at(SLIDE_GROUP_ID_PATH, 'group-99')}/duplicate`)).statusCode).toBe(404);
  });

  test('changes a slide group status and refuses an invalid status', async () => {
    const id = await created();
    expect((await ask('PATCH', `${at(SLIDE_GROUP_ID_PATH, id)}/status`, { enabled: false })).json().data.body.enabled).toBe(false);
    expect((await ask('PATCH', `${at(SLIDE_GROUP_ID_PATH, id)}/status`, { enabled: true })).json().data.body.enabled).toBe(true);
    expect((await ask('PATCH', `${at(SLIDE_GROUP_ID_PATH, id)}/status`, {})).statusCode).toBe(422);
  });

  test('regenerates a generated group and refuses regenerating a custom group', async () => {
    const generated = await created(GENERATED);
    expect((await ask('POST', `${at(SLIDE_GROUP_ID_PATH, generated)}/regenerate`, GENERATED)).statusCode).toBe(200);
    const custom = await created();
    const refused = await ask('POST', `${at(SLIDE_GROUP_ID_PATH, custom)}/regenerate`, GENERATED);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe(ENTITY_CONFLICT);
  });

  test('lists slide group history and refuses one it does not have', async () => {
    const id = await created();
    expect((await ask('GET', `${at(SLIDE_GROUP_ID_PATH, id)}/history`)).json().data).toHaveLength(1);
    expect((await ask('GET', `${at(SLIDE_GROUP_ID_PATH, 'group-99')}/history`)).statusCode).toBe(404);
  });

  test('reorders slides and maps an invalid slide list to a schema refusal', async () => {
    const id = await created();
    expect((await ask('PUT', `${at(SLIDE_GROUP_ID_PATH, id)}/slide-order`, { slideIds: [SLIDE_B.id, SLIDE_A.id] })).statusCode).toBe(200);
    const refused = await ask('PUT', `${at(SLIDE_GROUP_ID_PATH, id)}/slide-order`, { slideIds: [SLIDE_A.id, 'unknown'] });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe(VALIDATION_FAILED);
  });

  test('changes a slide status and refuses a slide it does not have', async () => {
    const id = await created();
    expect((await ask('PATCH', slideAt(SLIDE_PATH, id), { enabled: false })).json().data.body.slides[0].enabled).toBe(false);
    expect((await ask('PATCH', slideAt(SLIDE_PATH, id), { enabled: true })).json().data.body.slides[0].enabled).toBe(true);
    expect((await ask('PATCH', slideAt(SLIDE_PATH, id, 'unknown'), { enabled: true })).statusCode).toBe(422);
  });

  test('duplicates a slide and refuses a slide it does not have', async () => {
    const id = await created();
    expect((await ask('POST', `${slideAt(SLIDE_PATH, id)}/duplicate`)).json().data.body.slides).toHaveLength(3);
    expect((await ask('POST', `${slideAt(SLIDE_PATH, id, 'unknown')}/duplicate`)).statusCode).toBe(422);
  });

  test('overrides a slide layout and refuses a slide it does not have', async () => {
    const id = await created();
    expect((await ask('PUT', `${slideAt(SLIDE_PATH, id)}/layout`, { slideLayoutId: 'layout-b' })).json().data.body.slides[0].slideLayoutId).toBe('layout-b');
    expect((await ask('PUT', `${slideAt(SLIDE_PATH, id, 'unknown')}/layout`, { slideLayoutId: 'layout-b' })).statusCode).toBe(422);
  });

  test('clears a slide layout override and refuses a slide it does not have', async () => {
    const id = await created();
    await ask('PUT', `${slideAt(SLIDE_PATH, id)}/layout`, { slideLayoutId: 'layout-b' });
    expect((await ask('DELETE', `${slideAt(SLIDE_PATH, id)}/layout`)).json().data.body.slides[0].slideLayoutId).toBeUndefined();
    expect((await ask('DELETE', `${slideAt(SLIDE_PATH, id, 'unknown')}/layout`)).statusCode).toBe(422);
  });

  test('overrides a slide background and refuses a slide it does not have', async () => {
    const id = await created();
    expect((await ask('PUT', `${slideAt(SLIDE_PATH, id)}/background`, { background: 'navy' })).json().data.body.slides[0].background).toBe('navy');
    expect((await ask('PUT', `${slideAt(SLIDE_PATH, id, 'unknown')}/background`, { background: 'navy' })).statusCode).toBe(422);
  });

  test('clears a slide background override and refuses a slide it does not have', async () => {
    const id = await created();
    await ask('PUT', `${slideAt(SLIDE_PATH, id)}/background`, { background: 'navy' });
    expect((await ask('DELETE', `${slideAt(SLIDE_PATH, id)}/background`)).json().data.body.slides[0].background).toBeUndefined();
    expect((await ask('DELETE', `${slideAt(SLIDE_PATH, id, 'unknown')}/background`)).statusCode).toBe(422);
  });

  test('duplicates a language block and refuses a block it does not have', async () => {
    const id = await created();
    expect((await ask('POST', `${blockAt(`${SLIDE_PATH}/language-blocks/:blockId`, id)}/duplicate`)).json().data.body.slides[0].languageBlocks).toHaveLength(3);
    expect((await ask('POST', `${blockAt(`${SLIDE_PATH}/language-blocks/:blockId`, id, SLIDE_A.id, 'unknown')}/duplicate`)).statusCode).toBe(422);
  });

  test('reorders language blocks and refuses an invalid block list', async () => {
    const id = await created();
    expect((await ask('PUT', `${slideAt(SLIDE_PATH, id)}/language-block-order`, { blockIds: [BLOCK_B.id, BLOCK_A.id] })).statusCode).toBe(200);
    expect((await ask('PUT', `${slideAt(SLIDE_PATH, id)}/language-block-order`, { blockIds: [BLOCK_A.id, 'unknown'] })).statusCode).toBe(422);
  });
});

describe('slide group routes with an unknown group', () => {
  test.each([
    ['PUT', SLIDE_GROUP_ID_PATH, CUSTOM],
    ['POST', `${SLIDE_GROUP_ID_PATH}/regenerate`, GENERATED],
    ['PATCH', `${SLIDE_GROUP_ID_PATH}/status`, { enabled: false }],
    ['PUT', `${SLIDE_GROUP_ID_PATH}/slide-order`, { slideIds: [SLIDE_A.id, SLIDE_B.id] }],
    ['PATCH', SLIDE_PATH, { enabled: false }],
    ['POST', `${SLIDE_PATH}/duplicate`, undefined],
    ['PUT', `${SLIDE_PATH}/layout`, { slideLayoutId: 'layout-b' }],
    ['DELETE', `${SLIDE_PATH}/layout`, undefined],
    ['PUT', `${SLIDE_PATH}/background`, { background: 'navy' }],
    ['DELETE', `${SLIDE_PATH}/background`, undefined],
    ['POST', `${SLIDE_PATH}/language-blocks/:blockId/duplicate`, undefined],
    ['PUT', `${SLIDE_PATH}/language-block-order`, { blockIds: [BLOCK_A.id, BLOCK_B.id] }],
  ] as const)('answers not-found for %s %s with an unknown group', async (method, path, body) => {
    const response = await ask(method as Method, blockAt(path, 'group-99'), body);
    expect(response.statusCode).toBe(404);
  });
});

describe('slide group routes with a malformed body', () => {
  test.each([
    ['PUT', SLIDE_GROUP_ID_PATH],
    ['POST', `${SLIDE_GROUP_ID_PATH}/regenerate`],
    ['PUT', `${SLIDE_GROUP_ID_PATH}/slide-order`],
    ['PATCH', SLIDE_PATH],
    ['PUT', `${SLIDE_PATH}/layout`],
    ['PUT', `${SLIDE_PATH}/background`],
    ['PUT', `${SLIDE_PATH}/language-block-order`],
  ] as const)('answers unprocessable for %s %s with a malformed body', async (method, path) => {
    const id = await created();
    const response = await ask(method as Method, slideAt(path, id), {});
    expect(response.statusCode).toBe(422);
  });
});

describe('slide group route guards', () => {
  test('gates every route from a member session', async () => {
    const member = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [] });
    const refused = await ask('GET', at(SLIDE_GROUP_ID_PATH, 'group-1'), undefined, member);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe(FORBIDDEN);
  });

  test('refuses a request with no session', async () => {
    const response = await app.inject({ method: 'GET', url: at(SLIDE_GROUP_ID_PATH, 'group-1'), headers: { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current), host: HOST, origin: ORIGIN } });
    expect(response.statusCode).toBe(401);
  });

  test.each([
    ['POST', SLIDE_GROUPS_PATH], ['GET', SLIDE_GROUP_ID_PATH], ['PUT', SLIDE_GROUP_ID_PATH],
    ['POST', `${SLIDE_GROUP_ID_PATH}/duplicate`], ['PATCH', `${SLIDE_GROUP_ID_PATH}/status`],
    ['POST', `${SLIDE_GROUP_ID_PATH}/regenerate`], ['GET', `${SLIDE_GROUP_ID_PATH}/history`],
    ['PUT', `${SLIDE_GROUP_ID_PATH}/slide-order`], ['PATCH', SLIDE_PATH], ['POST', `${SLIDE_PATH}/duplicate`],
    ['PUT', `${SLIDE_PATH}/layout`], ['DELETE', `${SLIDE_PATH}/layout`], ['PUT', `${SLIDE_PATH}/background`],
    ['DELETE', `${SLIDE_PATH}/background`], ['POST', `${SLIDE_PATH}/language-blocks/:blockId/duplicate`],
    ['PUT', `${SLIDE_PATH}/language-block-order`],
  ])('answers not-found for %s %s without a store', async (method, path) => {
    await app.close();
    await serving(undefined, undefined);
    const url = blockAt(path, 'group-1');
    const response = await ask(method as Method, url, method === 'GET' || method === 'DELETE' ? undefined : {});
    expect(response.statusCode).toBe(404);
  });
});
