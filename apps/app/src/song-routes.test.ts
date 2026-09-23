import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, VALIDATION_FAILED } from '@holydeck/contracts/http';
import { SONGS_PATH } from '@holydeck/contracts/songs';
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
import { SONG_ID_PATH, serveSongRoutes } from './song-routes.js';
import { songSingerChordsOn } from './song-singer-chords.js';
import { slideLayoutContext, slideLayoutsOn } from './slide-layouts.js';
import { songsOn } from './songs.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { Identity } from './onboarding.js';
import type { SlideLayoutStore } from './slide-layouts.js';
import type { SongStore } from './songs.js';
import type { SongSingerChordsStore } from './song-singer-chords.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance } from 'fastify';

const START = Date.parse('2026-09-22T09:30:00.000Z');
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const CORRELATION = 'req-0f9c2a41';
const ADMINISTRATOR = `account:${'C'.repeat(22)}`;
const BODY = {
  titles: { tamil: 'பாடல்', romanized: 'Paadal' }, languages: [], sections: [], provenance: { source: 'manual' },
};

let app: FastifyInstance;
let sessions: SessionStore;
let identity: Identity;
let songs: SongStore;
let chords: SongSingerChordsStore;
let db: FakeDb;
let layouts: SlideLayoutStore;
let admin: StartedSession;
let tick: number;

const now = (): string => new Date(START + (tick += 1) * 1000 - 1000).toISOString();
const at = (path: string, id: string): string => path.replace(':id', id);
const singerAt = (songId: string, singerId: string): string => `${at(SONG_ID_PATH, songId)}/singers/${singerId}/chords`;
const headers = (held: StartedSession = admin) => ({
  [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current), host: HOST, 'x-forwarded-proto': 'https', origin: ORIGIN,
  cookie: sessionCookie(held.token, 60), [CSRF_HEADER]: held.record.csrf,
});
type Method = 'GET' | 'POST' | 'PUT';
type JsonResponse = {
  readonly data: { readonly stamp: { readonly id: string }; readonly revision: number; readonly body?: unknown } & Record<string, unknown>;
  readonly error: { readonly code: string; readonly fields: readonly unknown[] };
};
type Response = { readonly statusCode: number; readonly headers: Record<string, string | string[] | undefined>; readonly body: string; json(): JsonResponse };

const ask = (method: Method, url: string, payload?: unknown, held: StartedSession = admin, extra = {}): Promise<Response> =>
  app.inject({ method, url, headers: { ...headers(held), ...extra }, ...(payload === undefined ? {} : { payload: payload as never }) }) as Promise<Response>;
const create = (payload: unknown = { title: 'Paadal', body: BODY }, held?: StartedSession) =>
  ask('POST', SONGS_PATH, payload, held);
const created = async (): Promise<string> => (await create()).json().data.stamp.id as string;

const serving = async (
  held: Identity | undefined,
  store: SongStore | undefined = songs,
  chordStore: SongSingerChordsStore | undefined = chords,
): Promise<void> => {
  app = Fastify({ logger: false });
  withSafeErrors(app);
  guardMutations(app, { sessions });
  enforceAuthorization(app, { sessions, identity: undefined });
  serveSongRoutes(app, { songs: store, chords: chordStore, identity: held });
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
  songs = songsOn(db, { now, newId: () => `song-${(serial += 1)}` });
  chords = songSingerChordsOn(db, { now });
  layouts = slideLayoutsOn(db, { now, newId: () => `layout-${(serial += 1)}` });
  await serving(identity);
  admin = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [CONTENT_EDIT] });
});

afterEach(async () => app.close());

describe('song routes', () => {
  test('creates a song and refuses an invalid draft', async () => {
    expect((await create()).statusCode).toBe(201);
    const refused = await create({ title: '', body: BODY });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.code).toBe(VALIDATION_FAILED);
  });

  test('reads a song and refuses an invalid revision', async () => {
    const id = await created();
    expect((await ask('GET', at(SONG_ID_PATH, id))).json().data.revision).toBe(1);
    expect((await ask('GET', `${at(SONG_ID_PATH, id)}?revision=first`)).statusCode).toBe(422);
  });

  test('edits a song and refuses a stale revision', async () => {
    const id = await created();
    expect((await ask('PUT', at(SONG_ID_PATH, id), { expectedRevision: 1, body: { ...BODY, titles: { ...BODY.titles, romanized: 'Changed' } } })).statusCode).toBe(200);
    const refused = await ask('PUT', at(SONG_ID_PATH, id), { expectedRevision: 1, body: BODY });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe(ENTITY_CONFLICT);
  });

  test('reads raw YAML and refuses an invalid revision', async () => {
    const id = await created();
    const response = await ask('GET', `${at(SONG_ID_PATH, id)}/raw`);
    expect(response.headers['content-type']).toContain('text/yaml');
    expect((await ask('GET', `${at(SONG_ID_PATH, id)}/raw?revision=zero`)).statusCode).toBe(422);
  });

  test('edits raw YAML and returns located schema problems', async () => {
    const id = await created();
    const raw = await ask('GET', `${at(SONG_ID_PATH, id)}/raw`);
    expect((await ask('PUT', `${at(SONG_ID_PATH, id)}/raw`, raw.body, admin, { 'content-type': 'text/plain' })).statusCode).toBe(200);
    const refused = await ask('PUT', `${at(SONG_ID_PATH, id)}/raw`, 'titles: bad', admin, { 'content-type': 'text/plain' });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.fields).not.toHaveLength(0);
    const unknownLabel = await ask('PUT', `${at(SONG_ID_PATH, id)}/raw`, `${raw.body}sections: bad\n`, admin, { 'content-type': 'text/plain' });
    expect(unknownLabel.statusCode).toBe(422);
    const fields = unknownLabel.json().error.fields as readonly { line?: number; column?: number }[];
    expect(fields.some((field) => field.line !== undefined && field.column !== undefined)).toBe(true);
  });

  test('keeps the raw YAML round trip byte-identical', async () => {
    const id = await created();
    const raw = (await ask('GET', `${at(SONG_ID_PATH, id)}/raw`)).body;
    await ask('PUT', `${at(SONG_ID_PATH, id)}/raw`, raw, admin, { 'content-type': 'text/plain' });
    const replayed = (await ask('GET', `${at(SONG_ID_PATH, id)}/raw`)).body;
    expect(replayed).toBe(raw);
  });

  test('refuses a non-text body when editing raw YAML', async () => {
    const id = await created();
    const refused = await ask('PUT', `${at(SONG_ID_PATH, id)}/raw`, { not: 'text' });
    expect(refused.statusCode).toBe(422);
  });

  test('exports a song with an attachment header and refuses an invalid revision', async () => {
    const id = await created();
    const response = await ask('GET', `${at(SONG_ID_PATH, id)}/export`);
    expect(response.headers['content-disposition']).toBe(`attachment; filename="${id}.json"`);
    expect((await ask('GET', `${at(SONG_ID_PATH, id)}/export?revision=no`)).statusCode).toBe(422);
  });

  test('omits singer chords from the portable export', async () => {
    const id = await created();
    await ask('POST', singerAt(id, 'singer-1'), { chords: 'Am  F  C  G' });
    const exported = (await ask('GET', `${at(SONG_ID_PATH, id)}/export`)).body;
    expect(exported).not.toContain('Am  F  C  G');
    expect(exported).not.toContain('singer-1');
  });

  test('imports portable bytes and refuses malformed bytes', async () => {
    const id = await created();
    const text = (await ask('GET', `${at(SONG_ID_PATH, id)}/export`)).body;
    expect((await ask('POST', `${SONGS_PATH}/import`, { title: 'Imported', text })).statusCode).toBe(201);
    expect((await ask('POST', `${SONGS_PATH}/import`, { title: 'Imported', text: 'not json' })).statusCode).toBe(422);
  });

  test('keeps the raw and portable round trip byte-identical', async () => {
    const id = await created();
    const exported = (await ask('GET', `${at(SONG_ID_PATH, id)}/export`)).body;
    const imported = await ask('POST', `${SONGS_PATH}/import`, { title: 'Imported', text: exported });
    const replayed = (await ask('GET', `${at(SONG_ID_PATH, imported.json().data.stamp.id as string)}/export`)).body;
    expect(replayed).toBe(exported);
  });

  test('lists history and refuses a song it does not have', async () => {
    const id = await created();
    expect((await ask('GET', `${at(SONG_ID_PATH, id)}/history`)).json().data).toHaveLength(1);
    expect((await ask('GET', `${at(SONG_ID_PATH, 'song-99')}/history`)).statusCode).toBe(404);
  });

  test('generates slides and refuses an unavailable layout', async () => {
    const id = await created();
    const layout = await layouts.create(slideLayoutContext(ADMINISTRATOR, CORRELATION), { name: 'Layout', body: { boxes: [{
      id: 'static', kind: 'text', importance: 'required', frame: { x: 0, y: 0, width: 1, height: 1 },
      binding: { mode: 'static', text: 'Sunday' }, style: { fontFamily: 'Inter', fontWeight: 400, sizeRatio: 0.1, lineHeight: 1, align: 'start', verticalAlign: 'start' },
    }] } });
    const response = await ask('POST', `${at(SONG_ID_PATH, id)}/slides`, { songRevision: 1, slideLayoutId: layout.stamp.id, slideLayoutRevision: 1 });
    expect(response.statusCode).toBe(200);
    expect((await ask('POST', `${at(SONG_ID_PATH, id)}/slides`, {})).statusCode).toBe(422);
    const conflicted = await ask('POST', `${at(SONG_ID_PATH, id)}/slides`, { songRevision: 1, slideLayoutId: 'layout-99', slideLayoutRevision: 1 });
    expect(conflicted.statusCode).toBe(409);
  });

  test('creates, reads, and edits one singer’s chord data', async () => {
    const id = await created();
    const path = singerAt(id, 'singer-1');
    expect((await ask('POST', path, { chords: 'Am  F  C  G' })).statusCode).toBe(201);
    expect((await ask('GET', path)).json().data.chords).toBe('Am  F  C  G');
    expect((await ask('PUT', path, { chords: 'Dm  G  C' })).statusCode).toBe(200);
    expect((await ask('GET', path)).json().data.chords).toBe('Dm  G  C');
  });

  test('refuses duplicate chord creation for one song and singer', async () => {
    const path = singerAt(await created(), 'singer-1');
    await ask('POST', path, { chords: 'Am' });
    const refused = await ask('POST', path, { chords: 'Dm' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe(ENTITY_CONFLICT);
  });

  test('does not create chords through read or edit, and refuses an unknown song', async () => {
    const id = await created();
    expect((await ask('GET', singerAt(id, 'singer-1'))).statusCode).toBe(404);
    expect((await ask('PUT', singerAt(id, 'singer-1'), { chords: 'Am' })).statusCode).toBe(404);
    expect((await ask('GET', singerAt('song-99', 'singer-1'))).statusCode).toBe(404);
  });
});

describe('song route guards', () => {
  test('gates every route from a member session', async () => {
    const member = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [] });
    const refused = await ask('GET', at(SONG_ID_PATH, 'song-1'), undefined, member);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe(FORBIDDEN);
  });

  test('refuses a request with no session', async () => {
    const response = await app.inject({ method: 'GET', url: at(SONG_ID_PATH, 'song-1'), headers: { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current), host: HOST, origin: ORIGIN } });
    expect(response.statusCode).toBe(401);
  });

  test.each([
    ['POST', SONGS_PATH], ['GET', SONG_ID_PATH], ['PUT', SONG_ID_PATH], ['GET', `${SONG_ID_PATH}/raw`],
    ['PUT', `${SONG_ID_PATH}/raw`], ['GET', `${SONG_ID_PATH}/export`], ['POST', `${SONGS_PATH}/import`],
    ['GET', `${SONG_ID_PATH}/history`], ['POST', `${SONG_ID_PATH}/slides`], ['POST', `${SONG_ID_PATH}/singers/:singerId/chords`],
    ['GET', `${SONG_ID_PATH}/singers/:singerId/chords`], ['PUT', `${SONG_ID_PATH}/singers/:singerId/chords`],
  ])('answers not-found for %s %s without a store', async (method, path) => {
    await app.close();
    await serving(undefined, undefined);
    const response = await ask(method as Method, at(path, 'song-1'), method === 'GET' ? undefined : {});
    expect(response.statusCode).toBe(404);
  });
});
