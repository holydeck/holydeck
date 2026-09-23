import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT } from '@holydeck/contracts/http';
import { SERMON_IMPORT_PREVIEW_PATH } from '@holydeck/contracts/sermon-import';
import { SERMONS_PATH } from '@holydeck/contracts/sermons';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import { RESOLVE_TOOL_NAME } from '@holydeck/core/anthropic';
import { parseSermonFile } from '@holydeck/core/sermon';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { corpusClient } from './corpus.js';
import { FORBIDDEN, guardMutations } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { passkeysOn } from './passkeys.js';
import { CONTENT_EDIT, SERVICES_MANAGE } from './roles.js';
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

import type { HttpPost } from '@holydeck/core/anthropic';
import type { Fetching } from './corpus.js';
import type { Identity } from './onboarding.js';
import type { SermonBody, SermonStore } from './sermons.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { SlideLayoutStore } from './slide-layouts.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
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

const LIBRARY = 'http://corpus.example.invalid';
const CORPUS_TOKEN = 'a'.repeat(24);
const TAM_VERSES_URL = `${LIBRARY}/api/v1/translations/TAM/verses`;
const ROM_VERSES_URL = `${LIBRARY}/api/v1/translations/ROM/verses`;

// Chapter 117's verses the sermon fixture's entries need once each translation's offset is applied:
// TAM (no offset) needs {1, 2}; ROM (offset 1 on the first entry) needs {1, 3}.
const TAM_CHAPTER_117 = {
  verses: { '1': 'தமிழ் வசனம் 1', '2': 'தமிழ் வசனம் 2' },
  citation: 'Psalm 117 (TAM)',
  revision: 1,
  fetchedAt: '2026-09-13T09:30:00Z',
  source: 'cache',
};
const ROM_CHAPTER_117 = {
  verses: { '1': 'Romanized verse 1', '3': 'Romanized verse 3' },
  citation: 'Psalm 117 (ROM)',
  revision: 1,
  fetchedAt: '2026-09-13T09:30:00Z',
  source: 'cache',
};

/** Answers by base path, ignoring the query string, the same as `reference-routes.test.ts`'s stub. */
function routedByBase(byUrl: ReadonlyMap<string, { status: number; body: unknown }>): Fetching {
  return (url) => {
    const answer = byUrl.get(url.split('?')[0] ?? url) ?? { status: 500, body: {} };
    return Promise.resolve({ status: answer.status, json: () => Promise.resolve(answer.body) });
  };
}

const answeringCorpus = (): Fetching =>
  routedByBase(new Map([
    [TAM_VERSES_URL, { status: 200, body: TAM_CHAPTER_117 }],
    [ROM_VERSES_URL, { status: 200, body: ROM_CHAPTER_117 }],
  ]));

let app: FastifyInstance;
let sessions: SessionStore;
let identity: Identity;
let sermons: SermonStore;
let layouts: SlideLayoutStore;
let admin: StartedSession;
let tick: number;
let db: FakeDb;

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

const serving = async (
  held: Identity | undefined,
  store: SermonStore | undefined = sermons,
  fetching: Fetching = answeringCorpus(),
  anthropicApiKey?: string,
  httpPost?: HttpPost,
): Promise<void> => {
  app = Fastify({ logger: false });
  withSafeErrors(app);
  guardMutations(app, { sessions });
  enforceAuthorization(app, { sessions, identity: undefined });
  serveSermonRoutes(app, {
    sermons: store,
    corpus: corpusClient({ url: LIBRARY, token: CORPUS_TOKEN }, fetching),
    identity: held,
    anthropicApiKey,
    httpPost,
  });
  await app.ready();
};

beforeEach(async () => {
  tick = 0;
  db = fakeDb();
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
  admin = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [CONTENT_EDIT, SERVICES_MANAGE] });
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
    expect(empty.json().error.fields).toEqual([expect.objectContaining({ path: 'sermon.title' })]);
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

  test('edits sermons, checks the expected revision and handles missing and malformed bodies', async () => {
    const id = await created();
    const stale = await ask('PUT', at(SERMON_ID_PATH, id), { expectedRevision: 2, body: BODY });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe(ENTITY_CONFLICT);
    const edited = { expectedRevision: 1, body: { ...BODY, languages: { ta: BODY.languages['ta'] } } };
    expect((await ask('PUT', at(SERMON_ID_PATH, id), edited)).statusCode).toBe(200);
    expect((await ask('PUT', at(SERMON_ID_PATH, 'missing'), { expectedRevision: 1, body: BODY })).statusCode).toBe(404);
    expect((await ask('PUT', at(SERMON_ID_PATH, id), { expectedRevision: 2, body: { ...BODY, languages: {} } })).statusCode).toBe(422);
    expect((await ask('PUT', at(SERMON_ID_PATH, id), BODY)).statusCode).toBe(422);
  });

  test('reads and edits raw YAML, checking the expected revision', async () => {
    const id = await created();
    expect((await ask('GET', at(`${SERMON_ID_PATH}/raw`, 'missing'))).statusCode).toBe(404);
    const raw = await ask('GET', at(`${SERMON_ID_PATH}/raw`, id));
    expect(raw.headers['content-type']).toContain('text/yaml');
    expect((await ask('GET', `${at(`${SERMON_ID_PATH}/raw`, id)}?revision=1`)).statusCode).toBe(200);
    const rawPath = at(`${SERMON_ID_PATH}/raw`, id);
    expect((await ask('PUT', rawPath, { bad: true })).statusCode).toBe(422);
    expect((await ask('PUT', `${rawPath}?expectedRevision=1`, 'languages:\n\tbad', admin, { 'content-type': 'text/plain' })).statusCode).toBe(422);
    expect((await ask('PUT', rawPath, raw.body, admin, { 'content-type': 'text/plain' })).statusCode).toBe(422);
    expect((await ask('PUT', `${rawPath}?expectedRevision=bad`, raw.body, admin, { 'content-type': 'text/plain' })).statusCode).toBe(422);
    const staleRaw = await ask('PUT', `${rawPath}?expectedRevision=2`, raw.body, admin, { 'content-type': 'text/plain' });
    expect(staleRaw.statusCode).toBe(409);
    expect(staleRaw.json().error.code).toBe(ENTITY_CONFLICT);
    expect((await ask('PUT', `${rawPath}?expectedRevision=1`, raw.body, admin, { 'content-type': 'text/plain' })).statusCode).toBe(200);
    expect((await ask('PUT', `${at(`${SERMON_ID_PATH}/raw`, 'missing')}?expectedRevision=1`, raw.body, admin, { 'content-type': 'text/plain' })).statusCode).toBe(404);
  });

  test('lists history and answers not found when empty', async () => {
    expect((await ask('GET', at(`${SERMON_ID_PATH}/history`, 'missing'))).statusCode).toBe(404);
    const id = await created();
    expect((await ask('GET', at(`${SERMON_ID_PATH}/history`, id))).json().data).toHaveLength(1);
  });

  test('validates generation and refuses a missing sermon or Slide Layout', async () => {
    const id = await created();
    expect((await ask('POST', at(`${SERMON_ID_PATH}/slides`, id), {})).statusCode).toBe(422);
    const request = { sermonRevision: 1, slideLayoutId: 'layout-missing', slideLayoutRevision: 1 };
    const missing = await ask('POST', at(`${SERMON_ID_PATH}/slides`, 'missing'), request);
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error.code).toBe(ENTITY_CONFLICT);
    expect((await ask('POST', at(`${SERMON_ID_PATH}/slides`, id), request)).statusCode).toBe(409);
  });

  test('generates slides from the corpus this deployment holds', async () => {
    const id = await created();
    const layout = await layouts.create(slideLayoutContext(ADMINISTRATOR, CORRELATION), { name: 'Layout', body: { boxes: [{
      id: 'static', kind: 'text', importance: 'required', frame: { x: 0, y: 0, width: 1, height: 1 },
      binding: { mode: 'static', text: 'Sunday' },
      style: { fontFamily: 'Inter', fontWeight: 400, sizeRatio: 0.1, lineHeight: 1, align: 'start', verticalAlign: 'start' },
    }] } });
    const request = { sermonRevision: 1, slideLayoutId: layout.stamp.id, slideLayoutRevision: 1 };
    const generated = await ask('POST', at(`${SERMON_ID_PATH}/slides`, id), request);
    expect(generated.statusCode).toBe(200);
    const body = generated.json().data['body'] as { readonly mode: string; readonly slides: readonly unknown[] };
    expect(body.mode).toBe('generated');
    expect(body.slides).toHaveLength(2);
  });

  test('translates a genuine corpus refusal while generating slides', async () => {
    const id = await created();
    const failing: Fetching = () => Promise.resolve({
      status: 503,
      json: () => Promise.resolve({ error: { code: 'store_locked', message: 'the library is busy' } }),
    });
    await app.close();
    await serving(identity, sermons, failing);
    const request = { sermonRevision: 1, slideLayoutId: 'layout-missing', slideLayoutRevision: 1 };
    const refused = await ask('POST', at(`${SERMON_ID_PATH}/slides`, id), request);
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error.code).toBe('corpus.unavailable');
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

describe('POST /api/v1/sermons/import/preview', () => {
  const preview = (payload: unknown) => ask('POST', SERMON_IMPORT_PREVIEW_PATH, payload);
  const rowCount = () => [...db.rows.values()].reduce((total, rows) => total + rows.length, 0);

  test('answers the deterministic yaml with resolver "not-needed" when no key is set', async () => {
    const response = await preview({ text: 'John 3:16', translations: ['ta'] });
    expect(response.statusCode).toBe(200);
    expect(response.json().data['resolver']).toBe('not-needed');
  });

  test('answers resolver "not-configured" and lists the unresolved book in notices when a name is left over', async () => {
    const response = await preview({ text: 'Xyzzy 1:1\nHosea 4:6', translations: ['ta'] });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data['resolver']).toBe('not-configured');
    expect(data['notices']).toEqual([
      expect.stringContaining('ANTHROPIC_API_KEY'),
      expect.stringContaining('Xyzzy'),
    ]);
  });

  test('answers resolver "unavailable" when the resolver call fails', async () => {
    await app.close();
    await serving(identity, sermons, answeringCorpus(), 'test-key', async () => ({ status: 500, body: '{}' }));
    const response = await preview({ text: 'Xyzzy 1:1\nHosea 4:6', translations: ['ta'] });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data['resolver']).toBe('unavailable');
    expect(data['resolvedTokens']).toEqual([]);
  });

  test('writes nothing — no sermon exists after a preview call', async () => {
    const before = rowCount();
    const response = await preview({ text: 'John 3:16', translations: ['ta'] });
    expect(response.statusCode).toBe(200);
    expect(rowCount()).toBe(before);
  });

  test('records an integration.call audit entry when the resolver runs, carrying its token cost', async () => {
    await app.close();
    await serving(identity, sermons, answeringCorpus(), 'test-key', async () => ({
      status: 200,
      body: JSON.stringify({
        content: [
          { type: 'tool_use', id: 'toolu_test', name: RESOLVE_TOOL_NAME, input: { resolutions: [{ token: 'Xyzzy', usfm: 'JHN' }] } },
        ],
        usage: { input_tokens: 512, output_tokens: 64 },
      }),
    }));
    const response = await preview({ text: 'Xyzzy 1:1\nHosea 4:6', translations: ['ta'] });
    expect(response.statusCode).toBe(200);
    const events = db.rows.get('audit_events') ?? [];
    const entry = events.find((row) => row['action'] === 'integration.call');
    expect(entry).toBeDefined();
    expect(typeof entry?.['subject']).toBe('string');
    expect(entry?.['subject']).not.toBe('');
    expect(entry?.['requestTokens']).toBe(512);
    expect(entry?.['responseTokens']).toBe(64);
    for (const row of events) expect(String(row['detail'] ?? '')).not.toContain('Xyzzy 1:1');
  });

  test('refuses the 11th preview in a minute for the same account with 429 sermon.import_rate_limited', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await preview({ text: 'John 3:16', translations: ['ta'] });
      expect(response.statusCode).toBe(200);
    }
    const eleventh = await preview({ text: 'John 3:16', translations: ['ta'] });
    expect(eleventh.statusCode).toBe(429);
    expect(eleventh.json().error.code).toBe('sermon.import_rate_limited');
  });

  test('answers 422 for text over 20000 characters', async () => {
    const response = await preview({ text: 'x'.repeat(20_001), translations: ['ta'] });
    expect(response.statusCode).toBe(422);
  });
});
