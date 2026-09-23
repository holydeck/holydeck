import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { CONTENT_LANGUAGES_PATH } from '@holydeck/contracts/content-languages';
import { ENTITY_CONFLICT } from '@holydeck/contracts/http';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { serveContentLanguageRoutes, CONTENT_LANGUAGE_CATALOGUE_PATH, CONTENT_LANGUAGE_DEPENDENTS_PATH, CONTENT_LANGUAGE_KEY_PATH, CONTENT_LANGUAGE_STATUS_PATH } from './content-language-routes.js';
import { contentLanguagesOn } from './content-languages.js';
import { guardMutations } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { libraryOn } from './library.js';
import { passkeysOn } from './passkeys.js';
import { CATALOGUE_MANAGE, CONTENT_EDIT } from './roles.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { slideGroupsOn } from './slide-groups.js';
import { songContext, songsOn } from './songs.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { Identity } from './onboarding.js';
import type { ContentLanguageStore } from './content-languages.js';
import type { LibraryStore } from './library.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { SlideGroupStore } from './slide-groups.js';
import type { SongStore } from './songs.js';
import type { SongBody } from '@holydeck/contracts/songs';
import type { FastifyInstance } from 'fastify';

const START = Date.parse('2026-09-22T09:30:00.000Z');
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const ACTOR = `account:${'C'.repeat(22)}`;
const DRAFT = { key: 'ta', displayName: 'Tamil', script: 'Tamil', fallbackFont: 'Latha' };
const SONG_BODY: SongBody = {
  titles: { tamil: 'பாடல்', romanized: 'Paadal' },
  languages: ['ta'],
  sections: [{ id: 'verse-1', label: 'Verse 1', text: [{ languageKey: 'ta', text: 'வரிகள்' }] }],
  provenance: { source: 'manual' },
};
const ROUTES = [
  ['GET', CONTENT_LANGUAGES_PATH], ['POST', CONTENT_LANGUAGES_PATH], ['GET', CONTENT_LANGUAGE_CATALOGUE_PATH],
  ['GET', CONTENT_LANGUAGE_KEY_PATH], ['PUT', CONTENT_LANGUAGE_KEY_PATH], ['PATCH', CONTENT_LANGUAGE_STATUS_PATH],
  ['GET', CONTENT_LANGUAGE_DEPENDENTS_PATH],
] as const;

let app: FastifyInstance;
let sessions: SessionStore;
let identity: Identity;
let languages: ContentLanguageStore;
let songs: SongStore;
let slideGroups: SlideGroupStore;
let library: LibraryStore;
let admin: StartedSession;
let tick: number;
const now = (): string => new Date(START + (tick += 1) * 1000 - 1000).toISOString();
const at = (path: string, key: string): string => path.replace(':key', key);
const headers = (held: StartedSession = admin) => ({ [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current), host: HOST, 'x-forwarded-proto': 'https', origin: ORIGIN, cookie: sessionCookie(held.token, 60), [CSRF_HEADER]: held.record.csrf });
const ask = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, held: StartedSession = admin) =>
  app.inject({ method, url, headers: headers(held), ...(payload === undefined ? {} : { payload: payload as never }) });
const creating = (payload: unknown = DRAFT, held: StartedSession = admin) => ask('POST', CONTENT_LANGUAGES_PATH, payload, held);
const statusing = (key: string, archived: boolean, held: StartedSession = admin) => ask('PATCH', at(CONTENT_LANGUAGE_STATUS_PATH, key), { archived }, held);
const serving = async (held: Identity | undefined, store: ContentLanguageStore | undefined = languages) => {
  app = Fastify({ logger: false }); withSafeErrors(app); guardMutations(app, { sessions }); enforceAuthorization(app, { sessions, identity: undefined });
  serveContentLanguageRoutes(app, { contentLanguages: store, identity: held, songs, slideGroups, library }); await app.ready();
};

beforeEach(async () => {
  tick = 0;
  const db = fakeDb();
  sessions = sessionsOn(memorySessions().db, { now: () => new Date(START).toISOString() });
  identity = { accounts: accountsOn(memoryAccounts().db, { now, newId: () => 'A'.repeat(22), hash: async (value) => `hash:${value}`, verify: async (value, hash) => hash === `hash:${value}` }), audit: auditOn(db, { now, newId: () => 'audit' }), attempts: attemptsOn(memoryAttempts().db, { now }), totp: totpsOn(memoryTotp().db, { now }), passkeys: passkeysOn(memoryPasskeys().db, { now }) };
  languages = contentLanguagesOn(db, { now });
  songs = songsOn(db, { now });
  slideGroups = slideGroupsOn(db, { now });
  library = libraryOn(db, { now });
  await serving(identity);
  admin = await sessions.start(sessionContext('req-content-language'), { actor: ACTOR, permissions: [CATALOGUE_MANAGE, CONTENT_EDIT] });
});
afterEach(async () => { await app.close(); });

describe('content-language routes', () => {
  test('creates, validates, and refuses a duplicate key', async () => {
    expect((await creating()).statusCode).toBe(201);
    expect((await creating({ ...DRAFT, key: 'ml' })).statusCode).toBe(201);
    expect((await creating({ key: 'fr', script: 'Latin', fallbackFont: 'sans-serif' })).statusCode).toBe(422);
    const duplicate = await creating(); expect(duplicate.statusCode).toBe(409); expect(duplicate.json().error.code).toBe(ENTITY_CONFLICT);
  });

  test('gets, edits, and answers missing or invalid entries', async () => {
    await creating();
    expect((await ask('GET', at(CONTENT_LANGUAGE_KEY_PATH, 'ta'))).statusCode).toBe(200);
    expect((await ask('GET', at(CONTENT_LANGUAGE_KEY_PATH, 'fr'))).statusCode).toBe(404);
    expect((await ask('PUT', at(CONTENT_LANGUAGE_KEY_PATH, 'ta'), { displayName: 'Tamil spoken', script: 'Tamil', fallbackFont: 'Latha' })).statusCode).toBe(200);
    expect((await ask('PUT', at(CONTENT_LANGUAGE_KEY_PATH, 'fr'), { displayName: 'French', script: 'Latin', fallbackFont: 'sans-serif' })).statusCode).toBe(404);
    expect((await ask('PUT', at(CONTENT_LANGUAGE_KEY_PATH, 'ta'), { script: 'Tamil', fallbackFont: 'Latha' })).statusCode).toBe(422);
  });

  test('lists archived entries only on the managed surface', async () => {
    await creating(); await statusing('ta', true);
    expect((await ask('GET', CONTENT_LANGUAGES_PATH)).json().data).toHaveLength(1);
    const editor = await sessions.start(sessionContext('req-editor'), { actor: ACTOR, permissions: [CONTENT_EDIT] });
    expect((await ask('GET', CONTENT_LANGUAGE_CATALOGUE_PATH, undefined, editor)).json().data).toEqual([]);
  });

  test('archives and unarchives with state refusals', async () => {
    await creating();
    expect((await statusing('ta', true)).json().data.stamp.archivedAt).toBeDefined();
    expect((await statusing('ta', true)).statusCode).toBe(409);
    expect((await statusing('ta', false)).json().data.stamp.archivedAt).toBeUndefined();
    await creating({ ...DRAFT, key: 'ml' }); expect((await statusing('ml', false)).statusCode).toBe(409);
  });

  test('refuses an edit on an archived entry, a malformed status body, and status for a missing key', async () => {
    await creating();
    await statusing('ta', true);
    expect((await ask('PUT', at(CONTENT_LANGUAGE_KEY_PATH, 'ta'), { displayName: 'Tamil', script: 'Tamil', fallbackFont: 'Latha' })).statusCode).toBe(409);
    expect((await ask('PATCH', at(CONTENT_LANGUAGE_STATUS_PATH, 'ta'), { archived: 'yes' })).statusCode).toBe(422);
    expect((await statusing('missing', true)).statusCode).toBe(404);
  });

  test('enforces both permission surfaces and a session', async () => {
    const editor = await sessions.start(sessionContext('req-editor'), { actor: ACTOR, permissions: [CONTENT_EDIT] });
    const manager = await sessions.start(sessionContext('req-manager'), { actor: ACTOR, permissions: [CATALOGUE_MANAGE] });
    expect((await ask('GET', CONTENT_LANGUAGES_PATH, undefined, editor)).statusCode).toBe(403);
    expect((await ask('GET', CONTENT_LANGUAGE_CATALOGUE_PATH, undefined, manager)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: CONTENT_LANGUAGES_PATH, headers: { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current), host: HOST, origin: ORIGIN } })).statusCode).toBe(401);
  });

  test('counts a real referencing song, zero when nothing references it, and not-found for an unknown key', async () => {
    await creating();
    expect((await ask('GET', at(CONTENT_LANGUAGE_DEPENDENTS_PATH, 'ta'))).json().data).toEqual({ count: 0, approximate: false });
    await songs.create(songContext(ACTOR, 'song-corr'), 'Test Song', SONG_BODY);
    expect((await ask('GET', at(CONTENT_LANGUAGE_DEPENDENTS_PATH, 'ta'))).json().data).toEqual({ count: 1, approximate: false });
    expect((await ask('GET', at(CONTENT_LANGUAGE_DEPENDENTS_PATH, 'missing'))).statusCode).toBe(404);
  });

  test.each(ROUTES)('answers not-found without the store: %s %s', async (method, path) => {
    await app.close(); await serving(undefined, undefined);
    const url = at(path, 'ta');
    expect((await ask(method, url, method === 'POST' ? DRAFT : method === 'PUT' ? { displayName: 'Tamil', script: 'Tamil', fallbackFont: 'Latha' } : method === 'PATCH' ? { archived: true } : undefined)).statusCode).toBe(404);
  });

  test('never counts a song that merely spells a key somewhere in its text', async () => {
    await creating({ ...DRAFT, key: 'ml', displayName: 'Malayalam', script: 'Malayalam' });
    await songs.create(songContext(ACTOR, 'song-corr'), 'Test Song', {
      ...SONG_BODY,
      titles: { tamil: 'பாடல்', romanized: 'Psalm in html' },
    });
    expect((await ask('GET', at(CONTENT_LANGUAGE_DEPENDENTS_PATH, 'ml'))).json().data).toEqual({ count: 0, approximate: false });
  });

  test('lists each language with how many items use it', async () => {
    await creating();
    await creating({ ...DRAFT, key: 'ml', displayName: 'Malayalam', script: 'Malayalam' });
    await songs.create(songContext(ACTOR, 'song-corr'), 'Test Song', SONG_BODY);
    const listed = (await ask('GET', CONTENT_LANGUAGES_PATH)).json().data as { stamp: { id: string }; usage: number }[];
    expect(Object.fromEntries(listed.map((row) => [row.stamp.id, row.usage]))).toEqual({ ta: 1, ml: 0 });
  });
});
