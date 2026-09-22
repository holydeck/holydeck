// The output defaults surface is available to every authenticated client before it composes a Service.

import { actorFor } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import { DEFAULT_SAFE_AREA_MARGINS } from '@holydeck/contracts/snapshots';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { buildApp } from './app.js';
import { MEDIA_SIZE_CEILING_BYTES } from './media-routes.js';
import { OUTPUT_DEFAULTS_PATH } from './output-defaults-routes.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { loadSettings } from './settings.js';
import { memorySessions } from '../test/helpers/sessions.js';

import type { FastifyInstance } from 'fastify';
import type { StartedSession } from './sessions.js';

const NOW = '2026-09-22T09:30:00.000Z';
const OPERATOR = actorFor('C'.repeat(22));
const CORRELATION = 'req-0f9c2a41';

let app: FastifyInstance;
let operator: StartedSession;

const asking = (held: StartedSession | 'anonymous' = operator) =>
  app.inject({
    method: 'GET', url: OUTPUT_DEFAULTS_PATH,
    headers: {
      [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
      host: 'holydeck.example.invalid',
      'x-forwarded-proto': 'https',
      origin: 'https://holydeck.example.invalid',
      ...(held === 'anonymous' ? {} : { cookie: sessionCookie(held.token, 60), [CSRF_HEADER]: held.record.csrf }),
    },
  });

beforeEach(async () => {
  const sessions = sessionsOn(memorySessions().db, { now: () => NOW });
  operator = await sessions.start(sessionContext(CORRELATION), { actor: OPERATOR, permissions: [] });
  app = buildApp({
    settings: loadSettings({ env: {} }), logger: false,
    fetching: () => Promise.reject(new Error('this route must not ask the corpus')), sessions,
  });
  await app.ready();
});

afterEach(async () => app.close());

describe('output defaults routes', () => {
  test('serves exact defaults to every authenticated session', async () => {
    const response = await asking();
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      aspectRatio: '16:9', safeAreaMargins: DEFAULT_SAFE_AREA_MARGINS, uploadLimitBytes: MEDIA_SIZE_CEILING_BYTES,
    });
  });

  test('refuses an anonymous request', async () => {
    expect((await asking('anonymous')).statusCode).toBe(401);
  });
});
