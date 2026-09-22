import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { VALIDATION_FAILED } from '@holydeck/contracts/http';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { enforceAuthorization } from './authorization.js';
import { guardMutations } from './csrf.js';
import { withSafeErrors } from './failures.js';
import {
  REVISION_COMPARE_PATH,
  REVISION_PATH,
  REVISION_RESTORE_PATH,
  REVISIONS_PATH,
  serveRevisionRoutes,
} from './revision-routes.js';
import { revisionContext, revisionsOn } from './revisions.js';
import { CONTENT_HISTORY_MANAGE } from './roles.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memorySessions } from '../test/helpers/sessions.js';

import type { RevisionStore } from './revisions.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FastifyInstance } from 'fastify';

const START = Date.parse('2026-09-13T09:30:00.000Z');
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const CORRELATION = 'req-0f9c2a41';
const EDITOR = 'account:' + 'C'.repeat(22);

let app: FastifyInstance;
let sessions: SessionStore;
let revisions: RevisionStore;
let editor: StartedSession;

const now = (): string => new Date(START).toISOString();

const withHeaders = (held: StartedSession = editor) => ({
  [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
  host: HOST,
  'x-forwarded-proto': 'https',
  origin: ORIGIN,
  cookie: sessionCookie(held.token, 60),
  [CSRF_HEADER]: held.record.csrf,
});

const history = (contentId: string, query = '', held: StartedSession = editor) =>
  app.inject({
    method: 'GET',
    url: `${REVISIONS_PATH.replace(':contentId', contentId)}${query}`,
    headers: withHeaders(held),
  });

const comparing = (contentId: string, query: string, held: StartedSession = editor) =>
  app.inject({
    method: 'GET',
    url: `${REVISION_COMPARE_PATH.replace(':contentId', contentId)}${query}`,
    headers: withHeaders(held),
  });

const reading = (contentId: string, revision: string, held: StartedSession = editor) =>
  app.inject({
    method: 'GET',
    url: REVISION_PATH.replace(':contentId', contentId).replace(':revision', revision),
    headers: withHeaders(held),
  });

const restoring = (contentId: string, revision: string, held: StartedSession = editor) =>
  app.inject({
    method: 'POST',
    url: REVISION_RESTORE_PATH.replace(':contentId', contentId).replace(':revision', revision),
    headers: withHeaders(held),
  });

const serving = async (store: RevisionStore | undefined): Promise<void> => {
  app = Fastify({ logger: false });
  withSafeErrors(app);
  guardMutations(app, { sessions });
  enforceAuthorization(app, { sessions, identity: undefined });
  serveRevisionRoutes(app, { revisions: store });
  await app.ready();
};

const seed = (contentId: string, title: string) =>
  revisions.save(revisionContext(EDITOR, CORRELATION), { contentId, body: { title }, origin: 'manual-checkpoint' });

beforeEach(async () => {
  sessions = sessionsOn(memorySessions().db, { now: () => new Date(START).toISOString() });
  revisions = revisionsOn(fakeDb(), { now });
  await serving(revisions);
  editor = await sessions.start(sessionContext(CORRELATION), {
    actor: EDITOR,
    permissions: [CONTENT_HISTORY_MANAGE],
  });
});

afterEach(async () => {
  await app.close();
});

describe('revision history', () => {
  test('404s content that was never saved', async () => {
    expect((await history('song:none')).statusCode).toBe(404);
  });

  test('answers saved revisions, newest first', async () => {
    await seed('song:1', 'A');
    await seed('song:1', 'B');
    const response = await history('song:1');
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(2);
    expect(response.json().data[0]).toMatchObject({ revision: 2 });
    expect(response.json().data[1]).toMatchObject({ revision: 1 });
  });

  test('windows by limit and before', async () => {
    await seed('song:2', 'A');
    await seed('song:2', 'B');
    await seed('song:2', 'C');
    const response = await history('song:2', '?limit=1&before=3');
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([expect.objectContaining({ revision: 2 })]);
  });

  test('is answered not-found in a deployment with nowhere to keep history', async () => {
    await app.close();
    await serving(undefined);
    expect((await history('song:1')).statusCode).toBe(404);
  });

  test('refuses a session granted no permission here', async () => {
    const guest = await sessions.start(sessionContext(CORRELATION), {
      actor: 'account:' + 'D'.repeat(22),
      permissions: [],
    });
    await seed('song:3', 'A');
    expect((await history('song:3', '', guest)).statusCode).toBe(403);
  });
});

describe('comparing revisions', () => {
  test('422s a request missing from/to', async () => {
    const response = await comparing('song:1', '');
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
  });

  test('404s when either side does not exist', async () => {
    await seed('song:1', 'A');
    const response = await comparing('song:1', '?from=1&to=9');
    expect(response.statusCode).toBe(404);
  });

  test('answers the changed fields between two revisions', async () => {
    await seed('song:1', 'A');
    await seed('song:1', 'B');
    const response = await comparing('song:1', '?from=1&to=2');
    expect(response.statusCode).toBe(200);
    expect(response.json().data.diff).toEqual([{ path: 'title', kind: 'changed', before: 'A', after: 'B' }]);
  });
});

describe('a single revision', () => {
  test('404s a revision path segment that is not a positive whole number', async () => {
    expect((await reading('song:1', '0')).statusCode).toBe(404);
    expect((await reading('song:1', 'abc')).statusCode).toBe(404);
  });

  test('404s a revision that was never saved', async () => {
    expect((await reading('song:1', '1')).statusCode).toBe(404);
  });

  test('answers the revision', async () => {
    await seed('song:1', 'A');
    const response = await reading('song:1', '1');
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ contentId: 'song:1', revision: 1, body: { title: 'A' } });
  });
});

describe('restoring a revision', () => {
  test('404s a revision that was never saved', async () => {
    expect((await restoring('song:1', '1')).statusCode).toBe(404);
  });

  test('appends a new revision carrying the earlier body forward', async () => {
    await seed('song:1', 'A');
    await seed('song:1', 'B');
    const response = await restoring('song:1', '1');
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      appended: true,
      from: 1,
      revision: { revision: 3, body: { title: 'A' } },
    });
  });
});
