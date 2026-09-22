import { actorFor } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { SCRIPTURE_QUERY_MAX, SCRIPTURE_SEARCH_PATH } from '@holydeck/contracts/scripture';
import { sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { enforceAuthorization } from './authorization.js';
import { LIBRARY_UNAVAILABLE, corpusClient } from './corpus.js';
import { withSafeErrors } from './failures.js';
import { CONTENT_EDIT, PRESENTATION_CONTROL, SETTINGS_MANAGE } from './roles.js';
import { serveScriptureSearchRoutes } from './scripture-routes.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { memorySessions } from '../test/helpers/sessions.js';

import type { CorpusSearchHit, CorpusTranslation } from '@holydeck/contracts/corpus';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FastifyInstance } from 'fastify';

const ACTOR = actorFor('C'.repeat(22));
const HOST = 'holydeck.example.invalid';
const ORIGIN = 'https://holydeck.example.invalid';
const translations: readonly CorpusTranslation[] = [
  { abbreviation: 'KJV', id: 1, title: 'King James Version', language: 'English', syncedChapters: 1189, canonChapters: 1189, cached: true },
  { abbreviation: 'WEB', id: 2, title: 'World English Bible', language: 'English', syncedChapters: 1189, canonChapters: 1189, cached: true },
];
const hit = (fields: Partial<CorpusSearchHit> = {}): CorpusSearchHit => ({
  book: 'GEN', bookOrder: 0, chapter: 1, verse: 1, text: 'In the beginning God created the heaven and the earth.', revision: 3, phrase: true, occurrences: 1, ...fields,
});

function watching(held = translations, failing: string | undefined = undefined): { calls: string[]; client: ReturnType<typeof corpusClient> } {
  const calls: string[] = [];
  return {
    calls,
    client: {
      translations: () => { calls.push('translations'); return Promise.resolve({ ok: true, value: held } as const); },
      canon: () => { throw new Error('canon must not be called'); },
      verses: () => { throw new Error('verses must not be called'); },
      search: (abbr, query) => {
        calls.push(`search ${abbr}`);
        if (abbr === failing) return Promise.resolve({ ok: false, refusal: LIBRARY_UNAVAILABLE } as const);
        return Promise.resolve({ ok: true, value: { translation: abbr, query, hits: [hit({ text: `${abbr} result`, occurrences: abbr === 'KJV' ? 2 : 1 })] } } as const);
      },
    },
  };
}

let app: FastifyInstance;
let sessions: SessionStore;
let operator: StartedSession;

const serving = async (corpus: ReturnType<typeof corpusClient>): Promise<void> => {
  app = Fastify({ logger: false });
  withSafeErrors(app);
  enforceAuthorization(app, { sessions, identity: undefined });
  serveScriptureSearchRoutes(app, { corpus });
  await app.ready();
};

const asking = (query = 'q=in+the+beginning', held: StartedSession | 'anonymous' = operator) => app.inject({
  method: 'GET', url: `${SCRIPTURE_SEARCH_PATH}?${query}`,
  headers: {
    [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current), host: HOST, 'x-forwarded-proto': 'https', origin: ORIGIN,
    ...(held === 'anonymous' ? {} : { cookie: sessionCookie(held.token, 60) }),
  },
});

beforeEach(async () => {
  sessions = sessionsOn(memorySessions().db, { now: () => '2026-09-22T09:30:00.000Z' });
  await serving(watching().client);
  operator = await sessions.start(sessionContext('req-scripture'), { actor: ACTOR, permissions: [CONTENT_EDIT] });
});

afterEach(async () => { await app.close(); });

describe('searching the scripture this deployment holds', () => {
  test('returns cached translations ranked together', async () => {
    const watched = watching();
    await app.close(); await serving(watched.client);
    const response = await asking();
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((match: { reference: { abbr: string } }) => match.reference.abbr)).toEqual(['KJV', 'WEB']);
    expect(watched.calls).toEqual(['translations', 'search KJV', 'search WEB']);
  });

  test('skips translations the library has not cached', async () => {
    const watched = watching([...translations, { ...translations[0]!, abbreviation: 'NIV', cached: false }]);
    await app.close(); await serving(watched.client);
    expect((await asking()).statusCode).toBe(200);
    expect(watched.calls).not.toContain('search NIV');
  });

  test('refuses the whole search when one translation cannot be searched', async () => {
    const watched = watching(translations, 'WEB');
    await app.close(); await serving(watched.client);
    const response = await asking();
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({ code: LIBRARY_UNAVAILABLE.code, message: LIBRARY_UNAVAILABLE.message });
    expect(response.json().data).toBeUndefined();
  });

  test.each(['q=', 'q=+++'])('does not ask the corpus for an empty query: %s', async (query) => {
    const watched = watching();
    await app.close(); await serving(watched.client);
    const response = await asking(query);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
    expect(watched.calls).toEqual([]);
  });

  test('refuses a query beyond the maximum before asking the corpus', async () => {
    const watched = watching();
    await app.close(); await serving(watched.client);
    const response = await asking(`q=${'a'.repeat(SCRIPTURE_QUERY_MAX + 1)}`);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'scriptureSearch.q', code: 'field.too_large' })]));
    expect(watched.calls).toEqual([]);
  });

  test('requires a session and either permission', async () => {
    expect((await asking('q=x', 'anonymous')).statusCode).toBe(401);
    const bystander = await sessions.start(sessionContext('req-bystander'), { actor: ACTOR, permissions: [SETTINGS_MANAGE] });
    expect((await asking('q=x', bystander)).statusCode).toBe(403);
    const controller = await sessions.start(sessionContext('req-controller'), { actor: ACTOR, permissions: [PRESENTATION_CONTROL] });
    expect((await asking('q=', controller)).statusCode).toBe(200);
    expect((await asking('q=', operator)).statusCode).toBe(200);
  });
});
