import { actorFor } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { VALIDATION_FAILED } from '@holydeck/contracts/http';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import { TRANSLATION_OFFSETS_PATH } from '@holydeck/contracts/translation-offsets';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { FORBIDDEN, guardMutations, mutatingRoutesOf } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { passkeysOn } from './passkeys.js';
import { SETTINGS_MANAGE } from './roles.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { totpsOn } from './totp.js';
import { TranslationOffsetError, translationOffsetsOn } from './translation-offsets.js';
import { serveTranslationOffsetRoutes } from './translation-offset-routes.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';
import { memoryTranslationOffsets } from '../test/helpers/translation-offsets.js';

import type { Identity } from './onboarding.js';
import type { Document } from './repositories.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { TranslationOffsetStore } from './translation-offsets.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance, InjectOptions } from 'fastify';

const NOW = '2026-09-13T09:30:00.000Z';
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const CORRELATION = 'req-0f9c2a41';

const ADMIN = actorFor('A'.repeat(22));

let app: FastifyInstance;
let sessions: SessionStore;
let translationOffsets: TranslationOffsetStore;
let trail: FakeDb;
let identity: Identity;
let operator: StartedSession;
let clock: number;

const now = (): string => new Date(clock).toISOString();

const entries = (): Document[] => trail.rows.get('audit_events') ?? [];

const actions = (): unknown[] => entries().map((entry) => entry['action']);

const setPath = (abbr: string): string => `${TRANSLATION_OFFSETS_PATH}/${abbr}`;

const asking = (method: 'GET' | 'PUT', url: string, payload?: unknown, held?: StartedSession) =>
  app.inject({
    method,
    url,
    headers: {
      [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
      host: HOST,
      'x-forwarded-proto': 'https',
      origin: ORIGIN,
      ...(held === undefined ? {} : { cookie: sessionCookie(held.token, 60), [CSRF_HEADER]: held.record.csrf }),
    },
    payload: payload as InjectOptions['payload'],
  });

const settingOffset = (abbr: string, offset: unknown, held: StartedSession = operator) =>
  asking('PUT', setPath(abbr), { offset }, held);

beforeEach(async () => {
  clock = Date.parse(NOW);
  trail = fakeDb();
  sessions = sessionsOn(memorySessions().db, { now });
  translationOffsets = translationOffsetsOn(memoryTranslationOffsets().db);
  identity = {
    accounts: accountsOn(memoryAccounts().db, { now }),
    audit: auditOn(trail, { now, newId: () => `e${entries().length}` }),
    attempts: attemptsOn(memoryAttempts().db, { now }),
    totp: totpsOn(memoryTotp().db, { now }),
    passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
  app = Fastify({ logger: false });
  withSafeErrors(app);
  guardMutations(app, { sessions });
  enforceAuthorization(app, { sessions, identity: undefined });
  serveTranslationOffsetRoutes(app, { translationOffsets, identity });
  await app.ready();
  operator = await sessions.start(sessionContext(CORRELATION), { actor: ADMIN, permissions: [SETTINGS_MANAGE] });
});

afterEach(async () => {
  await app.close();
});

describe('reading every configured offset', () => {
  test('answers nothing configured before anything has been set', async () => {
    const response = await asking('GET', TRANSLATION_OFFSETS_PATH);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ offsets: [] });
  });

  test('answers what was set, and needs no session at all to ask', async () => {
    await settingOffset('KJV', 2);
    const response = await asking('GET', TRANSLATION_OFFSETS_PATH);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ offsets: [{ abbr: 'KJV', offset: 2 }] });
  });
});

describe('setting a translation offset', () => {
  test('upserts the offset, and answers the entry that was stored', async () => {
    const response = await settingOffset('KJV', 3);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ offset: { abbr: 'KJV', offset: 3 } });
  });

  test('accepts a negative offset, and zero, the same as a positive one', async () => {
    expect((await settingOffset('KJV', -4)).json().data.offset).toEqual({ abbr: 'KJV', offset: -4 });
    expect((await settingOffset('KJV', 0)).json().data.offset).toEqual({ abbr: 'KJV', offset: 0 });
  });

  test('an offset that is not a whole number is refused, and nothing is stored', async () => {
    const response = await settingOffset('KJV', 1.5);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe(VALIDATION_FAILED);
    expect(response.json().error.fields[0].path).toBe('translationOffset.offset');
    expect((await asking('GET', TRANSLATION_OFFSETS_PATH)).json().data).toEqual({ offsets: [] });
  });

  test('an offset missing from the body is refused', async () => {
    const response = await settingOffset('KJV', undefined);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields[0].path).toBe('translationOffset.offset');
  });

  test('an abbreviation that is blank is refused by the store, not stored under a blank key', async () => {
    const response = await settingOffset('%20', 1);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.fields[0].path).toBe('abbr');
  });
});

describe('who may ask any of it', () => {
  test('only setting an offset changes something, and only that route is behind the guard', () => {
    expect(mutatingRoutesOf(app)).toEqual([{ method: 'PUT', url: `${TRANSLATION_OFFSETS_PATH}/:abbr` }]);
  });

  test('reading is answered with no session at all', async () => {
    const response = await app.inject({
      method: 'GET',
      url: TRANSLATION_OFFSETS_PATH,
      headers: { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current), host: HOST, origin: ORIGIN },
    });
    expect(response.statusCode).toBe(200);
  });

  test('setting one refuses a request that carries no session at all', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: setPath('KJV'),
      headers: { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current), host: HOST, origin: ORIGIN },
      payload: { offset: 1 },
    });
    expect(response.statusCode).toBe(401);
  });

  test('setting one refuses a session that carries no settings.manage permission', async () => {
    const bystander = await sessions.start(sessionContext(CORRELATION), { actor: ADMIN, permissions: [] });
    const response = await settingOffset('KJV', 1, bystander);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(FORBIDDEN);
  });
});

describe('the trail this surface writes', () => {
  test('records who set an offset, for which translation and to what', async () => {
    await settingOffset('KJV', 3);
    expect(actions()).toEqual(['content.change']);
    expect(entries()[0]).toMatchObject({ actor: ADMIN, subject: 'translationOffset:KJV', outcome: 'allowed' });
    expect(String(entries()[0]?.['detail'])).toContain('3');
  });

  test('writes nothing for a request the shape of the body refused', async () => {
    await settingOffset('KJV', 'not a number');
    expect(entries()).toEqual([]);
  });

  test('writes nothing for reading, which is not a change', async () => {
    await settingOffset('KJV', 1);
    await asking('GET', TRANSLATION_OFFSETS_PATH);
    expect(actions()).toEqual(['content.change']);
  });
});

describe('what this surface refuses to answer at all', () => {
  const serving = async (bag: TranslationOffsetStore | undefined, held: Identity | undefined): Promise<FastifyInstance> => {
    const built = Fastify({ logger: false });
    withSafeErrors(built);
    guardMutations(built, { sessions });
    enforceAuthorization(built, { sessions, identity: undefined });
    serveTranslationOffsetRoutes(built, { translationOffsets: bag, identity: held });
    await built.ready();
    return built;
  };

  test('a deployment that keeps no translation offsets serves every path, and answers not-found from each', async () => {
    await app.close();
    app = await serving(undefined, identity);
    expect((await asking('GET', TRANSLATION_OFFSETS_PATH)).statusCode).toBe(404);
    expect((await settingOffset('KJV', 1)).statusCode).toBe(404);
  });

  test('a trail that refuses an entry does not cost the caller the offset they set', async () => {
    await app.close();
    identity = {
      ...identity,
      audit: {
        record: () => Promise.reject(new Error('the trail is unavailable')),
        list: () => Promise.reject(new Error('the trail is unavailable')),
      },
    };
    app = await serving(translationOffsets, identity);
    const response = await settingOffset('KJV', 1);
    expect(response.statusCode).toBe(200);
  });

  test('a store refusal other than a schema disagreement is this server’s defect, not the offset’s answer', async () => {
    await app.close();
    app = await serving(
      {
        ...translationOffsets,
        set: () => Promise.reject(new TranslationOffsetError('context', 'translationOffsets: no context at all')),
      },
      identity,
    );
    expect((await settingOffset('KJV', 1)).statusCode).toBe(500);
  });

  test('sets an offset even when this deployment keeps no identity to audit it against', async () => {
    await app.close();
    app = await serving(translationOffsets, undefined);
    expect((await settingOffset('KJV', 1)).statusCode).toBe(200);
  });
});
