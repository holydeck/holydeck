import { actorFor } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { enforceAuthorization } from './authorization.js';
import { corpusClient } from './corpus.js';
import { guardMutations } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { LOOKUP_BUDGET_MS, REFERENCE_LOOKUP_PATH, SHOWN_REFERENCES_PATH, serveReferenceRoutes } from './reference-routes.js';
import { PRESENTATION_CONTROL, SETTINGS_MANAGE } from './roles.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { shownReferencesOn } from './shown-references.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryShownReferences } from '../test/helpers/shown-references.js';

import type { Fetching } from './corpus.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { ShownReferenceStore } from './shown-references.js';
import type { FastifyInstance, InjectOptions } from 'fastify';

const NOW = '2026-09-16T19:05:00.000Z';
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const CORRELATION = 'req-0f9c2a41';

const OPERATOR = actorFor('C'.repeat(22));

const TOKEN = 'a'.repeat(24);
const LIBRARY = 'http://corpus:8080';
const CANON_URL = `${LIBRARY}/api/v1/translations/KJV/canon`;
const VERSES_URL = `${LIBRARY}/api/v1/translations/KJV/verses`;

const canon = {
  translation: 'KJV',
  source: 'bundled',
  books: [{ usfm: 'GEN', canon: 'ot', name: 'Genesis', chapters: [{ id: '1', label: '1' }, { id: '2', label: '2' }] }],
};

const verses = {
  verses: { '1': 'In the beginning God created the heaven and the earth.' },
  citation: 'Genesis 1:1 (KJV)',
  revision: 3,
  fetchedAt: '2026-09-13T09:30:00Z',
  source: 'cache',
};

/** Answers by base path, ignoring the query string, so the canon call and the verses call can differ. */
function routed(byUrl: ReadonlyMap<string, { status: number; body: unknown }>): Fetching {
  return (url) => {
    const answer = byUrl.get(url.split('?')[0] ?? url) ?? { status: 500, body: {} };
    return Promise.resolve({ status: answer.status, json: () => Promise.resolve(answer.body) });
  };
}

const answering = (body: unknown = verses, status = 200): Fetching =>
  routed(new Map([[CANON_URL, { status: 200, body: canon }], [VERSES_URL, { status, body }]]));

let app: FastifyInstance;
let sessions: SessionStore;
let shownReferences: ShownReferenceStore;
let recorded: ReturnType<typeof memoryShownReferences>;
let operator: StartedSession;

/** Named rather than left to `undefined`, so a call meaning "carry no session" cannot be read as a default. */
type Caller = StartedSession | 'anonymous';

const building = async (fetching: Fetching, store: ShownReferenceStore | undefined): Promise<void> => {
  app = Fastify({ logger: false });
  withSafeErrors(app);
  guardMutations(app, { sessions });
  enforceAuthorization(app, { sessions, identity: undefined });
  serveReferenceRoutes(app, { corpus: corpusClient({ url: LIBRARY, token: TOKEN }, fetching), shownReferences: store });
  await app.ready();
};

const asking = (method: 'GET' | 'POST', url: string, payload?: unknown, held: Caller = operator) =>
  app.inject({
    method,
    url,
    headers: {
      [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
      host: HOST,
      'x-forwarded-proto': 'https',
      origin: ORIGIN,
      ...(held === 'anonymous' ? {} : { cookie: sessionCookie(held.token, 60), [CSRF_HEADER]: held.record.csrf }),
    },
    payload: payload as InjectOptions['payload'],
  });

const lookingUp = (query = 'book=GEN&chapter=1&verses=1', held: Caller = operator) =>
  asking('GET', `${REFERENCE_LOOKUP_PATH}/KJV?${query}`, undefined, held);

const showing = (body: unknown = { abbr: 'KJV', book: 'GEN', chapter: 1, verses: '1' }, held: Caller = operator) =>
  asking('POST', SHOWN_REFERENCES_PATH, body, held);

beforeEach(async () => {
  recorded = memoryShownReferences();
  let tick = 0;
  let minted = 0;
  sessions = sessionsOn(memorySessions().db, { now: () => NOW });
  shownReferences = shownReferencesOn(recorded.db, {
    now: () => new Date(Date.parse(NOW) + tick++ * 1_000).toISOString(),
    newId: () => `s${minted++}`,
  });
  await building(answering(), shownReferences);
  operator = await sessions.start(sessionContext(CORRELATION), { actor: OPERATOR, permissions: [PRESENTATION_CONTROL] });
});

afterEach(async () => {
  await app.close();
});

describe('looking a reference up mid-service', () => {
  test('answers the verses and the revision they were read at', async () => {
    const response = await lookingUp();
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ verses });
  });

  test('is Control presentation, not merely a proved session', async () => {
    const bystander = await sessions.start(sessionContext(CORRELATION), { actor: OPERATOR, permissions: [SETTINGS_MANAGE] });
    expect((await lookingUp('book=GEN&chapter=1&verses=1', bystander)).statusCode).toBe(403);
    expect((await lookingUp('book=GEN&chapter=1&verses=1', 'anonymous')).statusCode).toBe(401);
  });

  test('refuses a reference the canon does not hold, without asking the library for verses at all', async () => {
    let askedVerses = false;
    await app.close();
    await building((url) => {
      if (url.startsWith(VERSES_URL)) askedVerses = true;
      return Promise.resolve({ status: 200, json: () => Promise.resolve(url.startsWith(CANON_URL) ? canon : verses) });
    }, shownReferences);
    const response = await lookingUp('book=GEN&chapter=99&verses=1');
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('corpus.reference.not_found');
    expect(askedVerses).toBe(false);
  });

  test('refuses a verse list it cannot read as malformed', async () => {
    const response = await lookingUp('book=GEN&chapter=1&verses=nope');
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('corpus.reference.malformed');
  });

  test('opens the passage at the revision asked for, so what was searched is what is read', async () => {
    let versesUrl = '';
    await app.close();
    await building((url) => {
      if (url.startsWith(VERSES_URL)) versesUrl = url;
      return Promise.resolve({ status: 200, json: () => Promise.resolve(url.startsWith(CANON_URL) ? canon : verses) });
    }, shownReferences);
    await lookingUp('book=GEN&chapter=1&verses=1&revision=2');
    expect(new URL(versesUrl).searchParams.get('revision')).toBe('2');
  });
});

// The whole of the no-implicit-show rule this backend can prove today: reading a passage is one route and
// putting it in front of the room is another, and only the second one leaves anything behind.
describe('a lookup never shows anything on its own', () => {
  test('writes nothing to the log, however many times it is asked', async () => {
    await lookingUp();
    await lookingUp('book=GEN&chapter=2&verses=1');
    expect(recorded.rows).toEqual([]);
    expect((await asking('GET', SHOWN_REFERENCES_PATH)).json().data).toEqual({ shown: [] });
  });

  test('writes exactly one entry when the operator explicitly shows the same reference', async () => {
    await lookingUp();
    expect(recorded.rows).toHaveLength(0);
    const response = await showing();
    expect(response.statusCode).toBe(201);
    expect(recorded.rows).toHaveLength(1);
  });
});

describe('showing a reference', () => {
  test('answers the same verses the lookup route answers, alongside what was recorded', async () => {
    const shown = await showing();
    const looked = await lookingUp();
    expect(shown.json().data.verses).toEqual(looked.json().data.verses);
    expect(shown.json().data.shown).toEqual({
      reference: { abbr: 'KJV', book: 'GEN', chapter: 1, verses: [1] },
      revision: 3,
      actor: OPERATOR,
      recordedAt: NOW,
    });
  });

  test('records the revision the library actually answered with, not one the caller chose', async () => {
    await app.close();
    await building(answering({ ...verses, revision: 11 }), shownReferences);
    await showing({ abbr: 'KJV', book: 'GEN', chapter: 1, verses: '1' });
    expect(recorded.rows.map((row) => row['revision'])).toEqual([11]);
  });

  test('records every verse of the reference, read in the comma and range grammar the library uses', async () => {
    await showing({ abbr: 'KJV', book: 'GEN', chapter: 1, verses: '5,1-3' });
    expect(recorded.rows[0]?.['verses']).toEqual([5, 1, 2, 3]);
  });

  test('records nothing when the library refused the passage, because nothing was shown', async () => {
    const response = await showing({ abbr: 'KJV', book: 'GEN', chapter: 99, verses: '1' });
    expect(response.statusCode).toBe(404);
    expect(recorded.rows).toEqual([]);
  });

  test('refuses the display when the revision could not be recorded, rather than showing it unrecorded', async () => {
    await app.close();
    const refusing: ShownReferenceStore = Object.freeze({
      record: () => Promise.reject(new Error('the log refused an entry')),
      recent: () => Promise.resolve([]),
    });
    await building(answering(), refusing);
    const response = await showing();
    expect(response.statusCode).toBe(500);
    // Not merely a failure code: the verses the library already answered with must not reach the caller
    // either, or a client could put them in front of a room from a reply that recorded nothing.
    expect(response.json().data).toBeUndefined();
  });

  test('refuses a body naming no reference at all', async () => {
    const response = await showing({ abbr: 'KJV', book: 'GEN' });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields.map((problem: { path: string }) => problem.path).toSorted()).toEqual([
      'shownReference.chapter',
      'shownReference.verses',
    ]);
  });

  test('refuses a verse list it cannot read, naming the field that could not be read', async () => {
    const response = await showing({ abbr: 'KJV', book: 'GEN', chapter: 1, verses: '4-1' });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields[0].path).toBe('shownReference.verses');
    expect(recorded.rows).toEqual([]);
  });

  test('is Control presentation, not merely a proved session', async () => {
    const bystander = await sessions.start(sessionContext(CORRELATION), { actor: OPERATOR, permissions: [SETTINGS_MANAGE] });
    expect((await showing(undefined, bystander)).statusCode).toBe(403);
    expect(recorded.rows).toEqual([]);
  });
});

describe('reading back what was shown', () => {
  test('answers the most recently shown first', async () => {
    await showing({ abbr: 'KJV', book: 'GEN', chapter: 1, verses: '1' });
    await showing({ abbr: 'KJV', book: 'GEN', chapter: 2, verses: '1' });
    const response = await asking('GET', SHOWN_REFERENCES_PATH);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.shown.map((entry: { reference: { chapter: number } }) => entry.reference.chapter)).toEqual([2, 1]);
  });
});

// The provisional interaction budget this surface is held to (see the route module for why this number,
// and who owns confirming it on real hardware). Measured over the whole HTTP round trip, because that is
// what an operator waits for — not the corpus call alone.
describe('the interaction budget an operator works within', () => {
  const ROUND_TRIPS = 5;

  const slowest = async (round: () => Promise<{ statusCode: number }>): Promise<number> => {
    // One warm-up first: the first request through a freshly built app pays for lazy route compilation
    // and a cold JIT, which is not the cost an operator pays on the second reference of a service.
    expect((await round()).statusCode).toBeLessThan(400);
    let worst = 0;
    for (let attempt = 0; attempt < ROUND_TRIPS; attempt += 1) {
      const started = performance.now();
      const response = await round();
      const elapsed = performance.now() - started;
      expect(response.statusCode).toBeLessThan(400);
      worst = Math.max(worst, elapsed);
    }
    return worst;
  };

  test('a book, chapter and verse lookup answers well within it', async () => {
    expect(await slowest(() => lookingUp())).toBeLessThan(LOOKUP_BUDGET_MS);
  });

  test('showing one, recording included, answers within it too', async () => {
    expect(await slowest(() => showing())).toBeLessThan(LOOKUP_BUDGET_MS);
  });
});

describe('a deployment with nowhere to record what was shown', () => {
  test('serves every path and shows nothing through any of them', async () => {
    await app.close();
    await building(answering(), undefined);
    expect((await lookingUp()).statusCode).toBe(404);
    expect((await showing()).statusCode).toBe(404);
    expect((await asking('GET', SHOWN_REFERENCES_PATH)).statusCode).toBe(404);
  });
});
