import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { ENTITY_CONFLICT, VALIDATION_FAILED } from '@holydeck/contracts/http';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { contentKindResolver } from './content-kind.js';
import { guardMutations } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { passkeysOn } from './passkeys.js';
import {
  REVISION_COMPARE_PATH,
  REVISION_PATH,
  REVISION_RESTORE_PATH,
  REVISIONS_PATH,
  serveRevisionRoutes,
} from './revision-routes.js';
import { RevisionError, revisionContext, revisionsOn } from './revisions.js';
import { CONTENT_EDIT, CONTENT_HISTORY_MANAGE, LAYOUTS_MANAGE, SERVICE_TEMPLATES_MANAGE } from './roles.js';
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
import type { RevisedKind } from './content-kind.js';
import type { RevisionStore } from './revisions.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
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
let trail: FakeDb;
let identity: Identity;

const now = (): string => new Date(START).toISOString();

const entries = (): Document[] => trail.rows.get('audit_events') ?? [];

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

// Two ids stand for the Admin-only kinds; everything else is ordinary content, as it is in a deployment.
const KINDS: Readonly<Record<string, RevisedKind>> = { 'layout:1': 'slideLayout', 'template:1': 'serviceTemplate' };
const kindOf = (contentId: string): Promise<RevisedKind> => Promise.resolve(KINDS[contentId] ?? 'content');

const serving = async (
  store: RevisionStore | undefined,
  held: Identity | undefined = undefined,
): Promise<void> => {
  app = Fastify({ logger: false });
  withSafeErrors(app);
  guardMutations(app, { sessions });
  enforceAuthorization(app, { sessions, identity: held });
  serveRevisionRoutes(app, { revisions: store, identity: held, kindOf });
  await app.ready();
};

const seed = (contentId: string, title: string) =>
  revisions.save(revisionContext(EDITOR, CORRELATION), { contentId, body: { title }, origin: 'manual-checkpoint' });

beforeEach(async () => {
  sessions = sessionsOn(memorySessions().db, { now: () => new Date(START).toISOString() });
  revisions = revisionsOn(fakeDb(), { now });
  trail = fakeDb();
  identity = {
    accounts: accountsOn(memoryAccounts().db, {
      now,
      newId: () => 'A'.repeat(22),
      hash: async (password) => `test-hash:${password}`,
      verify: async (password, stored) => stored === `test-hash:${password}`,
    }),
    audit: auditOn(trail, { now, newId: (() => { let n = 0; return () => `e${n++}`; })() }),
    attempts: attemptsOn(memoryAttempts().db, { now }),
    totp: totpsOn(memoryTotp().db, { now }),
    passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
  await serving(revisions);
  editor = await sessions.start(sessionContext(CORRELATION), {
    actor: EDITOR,
    permissions: [CONTENT_HISTORY_MANAGE, CONTENT_EDIT],
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

describe('restoring a revision another writer just moved past', () => {
  test('answers the race as a conflict rather than a fault', async () => {
    await seed('song:1', 'A');
    await app.close();
    await serving({
      ...revisions,
      restore: () => Promise.reject(new RevisionError('conflict', 'revision 2 of song:1 was appended by another writer')),
    });
    const response = await restoring('song:1', '1');
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe(ENTITY_CONFLICT);
  });
});

describe('restoring a revision, with an identity to audit against', () => {
  beforeEach(async () => {
    await serving(revisions, identity);
  });

  test('records a content.revision.restore entry naming the restored revision', async () => {
    await seed('song:1', 'A');
    await seed('song:1', 'B');
    const response = await restoring('song:1', '1');
    expect(response.statusCode).toBe(200);
    expect(entries()).toEqual([
      expect.objectContaining({
        actor: EDITOR,
        action: 'content.revision.restore',
        subject: 'song:1',
        outcome: 'allowed',
      }),
    ]);
    expect(entries()[0]?.['detail']).toContain('1');
  });

  test('records nothing when there is no identity to audit against', async () => {
    await serving(revisions, undefined);
    await seed('song:1', 'A');
    await seed('song:1', 'B');
    const response = await restoring('song:1', '1');
    expect(response.statusCode).toBe(200);
    expect(entries()).toEqual([]);
  });

  test('a trail that refuses an entry does not cost the restore', async () => {
    await seed('song:1', 'A');
    await seed('song:1', 'B');
    await serving(revisions, {
      ...identity,
      audit: {
        record: () => Promise.reject(new Error('the trail is unavailable')),
        list: () => Promise.reject(new Error('the trail is unavailable')),
      },
    });
    const response = await restoring('song:1', '1');
    expect(response.statusCode).toBe(200);
  });
});

describe('the content kind a revision belongs to', () => {
  const holding = (permissions: readonly string[]) =>
    sessions.start(sessionContext(CORRELATION), { actor: 'account:' + 'E'.repeat(22), permissions: [CONTENT_HISTORY_MANAGE, ...permissions] });

  test('keeps an Editor out of a Slide Layout and a Service Template, on every route', async () => {
    await seed('layout:1', 'A');
    await seed('layout:1', 'B');
    await seed('template:1', 'A');
    for (const contentId of ['layout:1', 'template:1']) {
      expect((await history(contentId)).statusCode).toBe(403);
      expect((await comparing(contentId, '?from=1&to=1')).statusCode).toBe(403);
      expect((await reading(contentId, '1')).statusCode).toBe(403);
      expect((await restoring(contentId, '1')).statusCode).toBe(403);
    }
    expect(await revisions.history(revisionContext(EDITOR, CORRELATION), 'layout:1')).toHaveLength(2);
  });

  test('lets each kind in with the permission that administers it, and only that one', async () => {
    await seed('layout:1', 'A');
    await seed('template:1', 'A');
    const layouts = await holding([LAYOUTS_MANAGE]);
    const templates = await holding([SERVICE_TEMPLATES_MANAGE]);
    expect((await history('layout:1', '', layouts)).statusCode).toBe(200);
    expect((await history('template:1', '', layouts)).statusCode).toBe(403);
    expect((await history('template:1', '', templates)).statusCode).toBe(200);
    expect((await history('layout:1', '', templates)).statusCode).toBe(403);
  });

  test('needs content editing for ordinary content, history alone is not enough', async () => {
    await seed('song:9', 'A');
    const historian = await holding([]);
    expect((await history('song:9', '', historian)).statusCode).toBe(403);
    expect((await restoring('song:9', '1', historian)).statusCode).toBe(403);
  });

  test('records the refusal in the trail', async () => {
    await serving(revisions, identity);
    await seed('layout:1', 'A');
    expect((await restoring('layout:1', '1')).statusCode).toBe(403);
    expect(entries()).toEqual([
      expect.objectContaining({ actor: EDITOR, action: 'authorization.refuse', outcome: 'refused' }),
    ]);
  });
});

describe('resolving a content kind from the stores that own one', () => {
  const owning = (ids: readonly string[]) => ({ preview: (_context: unknown, id: string) => Promise.resolve(ids.includes(id) ? {} : undefined) });

  test('names the store that knows the id, and ordinary content otherwise', async () => {
    const resolve = contentKindResolver({ slideLayouts: owning(['l']), serviceTemplates: owning(['t']) });
    expect(await resolve('l', EDITOR, CORRELATION)).toBe('slideLayout');
    expect(await resolve('t', EDITOR, CORRELATION)).toBe('serviceTemplate');
    expect(await resolve('s', EDITOR, CORRELATION)).toBe('content');
  });

  test('reads a deployment without either store as ordinary content', async () => {
    const resolve = contentKindResolver({ slideLayouts: undefined, serviceTemplates: undefined });
    expect(await resolve('l', EDITOR, CORRELATION)).toBe('content');
  });
});
