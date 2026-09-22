import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT } from '@holydeck/contracts/http';
import { SERMONS_PATH } from '@holydeck/contracts/sermons';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import { parseSermonFile } from '@holydeck/core/sermon';
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
import { SERMON_ID_PATH, serveSermonRoutes } from './sermon-routes.js';
import { sermonsOn } from './sermons.js';
import { slideLayoutContext, slideLayoutsOn } from './slide-layouts.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { Identity } from './onboarding.js';
import type { SermonBody, SermonStore } from './sermons.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { SlideLayoutStore } from './slide-layouts.js';
import type { FastifyInstance } from 'fastify';

const START = Date.parse('2026-09-22T09:30:00.000Z');
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const CORRELATION = 'req-0f9c2a41';
const ADMINISTRATOR = `account:${'C'.repeat(22)}`;
const BODY: SermonBody = {
  sermon: parseSermonFile(`translations: [TAM, ROM]
verses:
  - {book: PSA, chapter: 117, verses: 2, offsets: {ROM: 1}}
  - {book: PSA, chapter: 117, verses: 1}
`),
  languages: {
    ta: { translation: 'TAM', title: 'நன்றி', speaker: 'பேச்சாளர்', points: ['இரக்கம்', 'துதி'] },
    'ta-Latn': { translation: 'ROM', title: 'Nandri', speaker: 'Speaker', points: ['Kindness', 'Praise'] },
  },
};

let app: FastifyInstance;
let sessions: SessionStore;
let identity: Identity;
let sermons: SermonStore;
let layouts: SlideLayoutStore;
let admin: StartedSession;
let tick: number;

const now = (): string => new Date(START + (tick += 1) * 1000 - 1000).toISOString();
const at = (path: string, id: string): string => path.replace(':id', id);
const headers = (held: StartedSession = admin) => ({
  [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current), host: HOST, 'x-forwarded-proto': 'https', origin: ORIGIN,
  cookie: sessionCookie(held.token, 60), [CSRF_HEADER]: held.record.csrf,
});
type Method = 'GET' | 'POST' | 'PUT';
type Response = { readonly statusCode: number; readonly headers: Record<string, string | string[] | undefined>; readonly body: string; json(): { readonly data: Record<string, unknown>; readonly error: { readonly code: string; readonly fields: readonly unknown[] } } };
const ask = (method: Method, url: string, payload?: unknown, held: StartedSession = admin, extra = {}): Promise<Response> =>
  app.inject({ method, url, headers: { ...headers(held), ...extra }, ...(payload === undefined ? {} : { payload: payload as never }) }) as Promise<Response>;
const create = (payload: unknown = { title: 'Sunday sermon', body: BODY }) => ask('POST', SERMONS_PATH, payload);
const created = async (): Promise<string> => ((await create()).json().data['stamp'] as { readonly id: string }).id;

const serving = async (held: Identity | undefined, store: SermonStore | undefined = sermons): Promise<void> => {
  app = Fastify({ logger: false });
  withSafeErrors(app);
  guardMutations(app, { sessions });
  enforceAuthorization(app, { sessions, identity: undefined });
  serveSermonRoutes(app, { sermons: store, identity: held });
  await app.ready();
};

beforeEach(async () => {
  tick = 0;
  const db = fakeDb();
  sessions = sessionsOn(memorySessions().db, { now: () => new Date(START).toISOString() });
  identity = {
    accounts: accountsOn(memoryAccounts().db, { now, newId: () => 'A'.repeat(22), hash: async (password) => `test-hash:${password}`, verify: async (password, stored) => stored === `test-hash:${password}` }),
    audit: auditOn(db, { now, newId: () => 'audit' }), attempts: attemptsOn(memoryAttempts().db, { now }),
    totp: totpsOn(memoryTotp().db, { now }), passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
  let serial = 0;
  sermons = sermonsOn(db, { now, newId: () => `sermon-${(serial += 1)}` });
  layouts = slideLayoutsOn(db, { now, newId: () => `layout-${(serial += 1)}` });
  await serving(identity);
  admin = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [CONTENT_EDIT] });
});

afterEach(async () => app.close());

describe('sermon routes', () => {
  test('creates sermons and reports envelope and body schema failures', async () => {
    expect((await create()).statusCode).toBe(201);
    const title = await create({ title: 1, body: BODY });
    expect(title.statusCode).toBe(422);
    expect(title.json().error.fields).toHaveLength(1);
    const empty = await create({ title: '', body: BODY });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error.fields).toEqual([expect.objectContaining({ path: 'sermon' })]);
    const body = await create({ title: 'Broken', body: { ...BODY, languages: {} } });
    expect(body.statusCode).toBe(422);
    expect(body.json().error.fields).not.toHaveLength(0);
  });

  test('reads current and requested revisions', async () => {
    const id = await created();
    expect((await ask('GET', at(SERMON_ID_PATH, id))).json().data['revision']).toBe(1);
    expect((await ask('GET', `${at(SERMON_ID_PATH, id)}?revision=1`)).statusCode).toBe(200);
    expect((await ask('GET', `${at(SERMON_ID_PATH, id)}?revision=bad`)).statusCode).toBe(422);
    expect((await ask('GET', `${at(SERMON_ID_PATH, id)}?revision=`)).statusCode).toBe(422);
    expect((await ask('GET', at(SERMON_ID_PATH, 'missing'))).statusCode).toBe(404);
  });

  test('edits sermons and handles missing and malformed bodies', async () => {
    const id = await created();
    expect((await ask('PUT', at(SERMON_ID_PATH, id), { ...BODY, languages: { ta: BODY.languages['ta'] } })).statusCode).toBe(200);
    expect((await ask('PUT', at(SERMON_ID_PATH, 'missing'), BODY)).statusCode).toBe(404);
    expect((await ask('PUT', at(SERMON_ID_PATH, id), { ...BODY, languages: {} })).statusCode).toBe(422);
  });

  test('reads and edits raw YAML', async () => {
    const id = await created();
    expect((await ask('GET', at(`${SERMON_ID_PATH}/raw`, 'missing'))).statusCode).toBe(404);
    const raw = await ask('GET', at(`${SERMON_ID_PATH}/raw`, id));
    expect(raw.headers['content-type']).toContain('text/yaml');
    expect((await ask('GET', `${at(`${SERMON_ID_PATH}/raw`, id)}?revision=1`)).statusCode).toBe(200);
    expect((await ask('PUT', at(`${SERMON_ID_PATH}/raw`, id), { bad: true })).statusCode).toBe(422);
    expect((await ask('PUT', at(`${SERMON_ID_PATH}/raw`, id), 'languages:\n\tbad', admin, { 'content-type': 'text/plain' })).statusCode).toBe(422);
    expect((await ask('PUT', at(`${SERMON_ID_PATH}/raw`, id), raw.body, admin, { 'content-type': 'text/plain' })).statusCode).toBe(200);
    expect((await ask('PUT', at(`${SERMON_ID_PATH}/raw`, 'missing'), raw.body, admin, { 'content-type': 'text/plain' })).statusCode).toBe(404);
  });

  test('lists history and answers not found when empty', async () => {
    expect((await ask('GET', at(`${SERMON_ID_PATH}/history`, 'missing'))).statusCode).toBe(404);
    const id = await created();
    expect((await ask('GET', at(`${SERMON_ID_PATH}/history`, id))).json().data).toHaveLength(1);
  });

  test('validates generation and translates its reachable corpus failure', async () => {
    const id = await created();
    expect((await ask('POST', at(`${SERMON_ID_PATH}/slides`, id), {})).statusCode).toBe(422);
    const request = { sermonRevision: 1, slideLayoutId: 'layout-missing', slideLayoutRevision: 1 };
    const missing = await ask('POST', at(`${SERMON_ID_PATH}/slides`, 'missing'), request);
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error.code).toBe(ENTITY_CONFLICT);
    expect((await ask('POST', at(`${SERMON_ID_PATH}/slides`, id), request)).statusCode).toBe(409);
    const layout = await layouts.create(slideLayoutContext(ADMINISTRATOR, CORRELATION), { name: 'Layout', body: { boxes: [{
      id: 'static', kind: 'text', importance: 'required', frame: { x: 0, y: 0, width: 1, height: 1 },
      binding: { mode: 'static', text: 'Sunday' },
      style: { fontFamily: 'Inter', fontWeight: 400, sizeRatio: 0.1, lineHeight: 1, align: 'start', verticalAlign: 'start' },
    }] } });
    const generated = await ask('POST', at(`${SERMON_ID_PATH}/slides`, id), { ...request, slideLayoutId: layout.stamp.id });
    expect(generated.statusCode).toBe(404);
    expect(generated.json().error.code).toBe('corpus.reference.not_found');
  });
});

describe('sermon route guards', () => {
  test('gates a member session', async () => {
    const member = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [] });
    const refused = await ask('GET', at(SERMON_ID_PATH, 'sermon-1'), undefined, member);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe(FORBIDDEN);
  });

  test('refuses no session', async () => {
    const response = await app.inject({ method: 'GET', url: at(SERMON_ID_PATH, 'sermon-1'), headers: { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current), host: HOST, origin: ORIGIN } });
    expect(response.statusCode).toBe(401);
  });

  test.each([
    ['POST', SERMONS_PATH], ['GET', SERMON_ID_PATH], ['PUT', SERMON_ID_PATH], ['GET', `${SERMON_ID_PATH}/raw`],
    ['PUT', `${SERMON_ID_PATH}/raw`], ['GET', `${SERMON_ID_PATH}/history`], ['POST', `${SERMON_ID_PATH}/slides`],
  ])('answers not-found for %s %s without a store', async (method, path) => {
    await app.close();
    await serving(undefined, undefined);
    const response = await ask(method as Method, at(path, 'sermon-1'), method === 'GET' ? undefined : {});
    expect(response.statusCode).toBe(404);
  });
});
