import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ACCOUNTS_PATH, ONBOARDING_PATH } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW, UPDATE_REQUIRED_MESSAGE } from '@holydeck/contracts/clients';
import { MESSAGE_CODES, UPDATE_REQUIRED } from '@holydeck/contracts/http';
import { SESSION_PATH, TICKET_PATH } from '@holydeck/contracts/sessions';
import { TOTP_PATH, TOTP_RECOVERY_PATH, TOTP_VERIFICATION_PATH } from '@holydeck/contracts/totp';
import { PASSKEY_OPTIONS_PATH, PASSKEY_PATH } from '@holydeck/contracts/webauthn';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VERSIONED_PREFIX, buildApp } from './app.js';
import { SIGN_IN_REFUSED } from './session-routes.js';
import { UNGUARDED, mutatingRoutesOf } from './csrf.js';
import { CORPUS_WORDING, type Fetching } from './corpus.js';
import { SECURITY_HEADERS, readWebBuild } from './static.js';
import { DEFAULT_SETTINGS, type LoadedSettings } from './settings.js';

import type { InjectOptions } from 'fastify';
import type { WebAsset } from './static.js';

const sources: LoadedSettings['sources'] = {
  port: 'default',
  dataDir: 'default',
  mediaRoot: 'default',
  locale: 'file',
  corpusUrl: 'default',
  corpusToken: 'default',
  mongoUrl: 'default',
};

const settings: LoadedSettings = {
  values: { ...DEFAULT_SETTINGS, locale: 'de' },
  sources,
  path: '/data/holydeck/config/settings.yaml',
};

const withCorpus: LoadedSettings = {
  ...settings,
  values: { ...settings.values, corpusUrl: 'http://corpus:8080', corpusToken: 'a'.repeat(24) },
};

// A deployment without a library must never reach one, so the default fetch in these tests refuses.
const refusing: Fetching = () => Promise.reject(new Error('nothing in this test may leave the process'));

const served = async (
  request: { url: string; headers?: Record<string, string> },
): Promise<{ statusCode: number; body: unknown }> => {
  const app = buildApp({ settings, logger: false, fetching: refusing });
  try {
    const response = await app.inject({ method: 'GET', url: request.url, headers: request.headers });
    return { statusCode: response.statusCode, body: response.json() };
  } finally {
    await app.close();
  }
};

const current = { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current) };

// The contract the guard exists for, asked of the application rather than of a test double: every route
// this server registers that changes something is one the guard saw, and every one of them refuses a
// request carrying no session. A route added without the check is absent from the first list and reachable
// in the second, and this fails either way.
describe('every route that changes something', () => {
  it('is one the session guard is on, and the list is the whole list', () => {
    const app = buildApp({ settings, logger: false, fetching: refusing });
    expect(mutatingRoutesOf(app)).toEqual([
      { method: 'DELETE', url: SESSION_PATH },
      { method: 'POST', url: TICKET_PATH },
      // Served whether or not this deployment keeps accounts, so that the four changes a second factor
      // takes are counted here in every deployment rather than in only some of them.
      { method: 'POST', url: TOTP_PATH },
      { method: 'POST', url: TOTP_VERIFICATION_PATH },
      { method: 'POST', url: TOTP_RECOVERY_PATH },
      { method: 'DELETE', url: TOTP_PATH },
      { method: 'POST', url: PASSKEY_OPTIONS_PATH },
      { method: 'POST', url: PASSKEY_PATH },
      { method: 'PATCH', url: `${PASSKEY_PATH}/:id` },
      { method: 'DELETE', url: `${PASSKEY_PATH}/:id` },
      // The first route a permission gates, and not merely a proved session — still counted here, because
      // the guard it is behind is asked before the permission is.
      { method: 'PATCH', url: `${ACCOUNTS_PATH}/:id/control-presentation` },
    ]);
  });

  // An exception the guard declares is only sound if it names a route this application registers: a path
  // in `UNGUARDED` that nothing serves is dead text, and one that serves something else is a hole.
  it('is behind it except the two declared, which are registered and answered without a session', async () => {
    expect(UNGUARDED).toEqual([`POST ${ONBOARDING_PATH}`, `POST ${SESSION_PATH}`]);
    const app = buildApp({ settings, logger: false, fetching: refusing });
    // Neither is 401 for want of a session: the guard is on neither. The claim is not-found because this
    // deployment was handed no accounts to claim, and signing in is refused in the words every refused
    // sign-in takes — which is how a deployment with no accounts says nothing about having none.
    const claim = await app.inject({ method: 'POST', url: ONBOARDING_PATH, headers: current });
    expect(claim.statusCode).toBe(404);
    const signIn = await app.inject({ method: 'POST', url: SESSION_PATH, headers: current });
    expect(signIn.statusCode).toBe(401);
    expect(signIn.json().error.code).toBe(SIGN_IN_REFUSED);
    await app.close();
  });

  it('refuses a request that carries no session, whichever route it is', async () => {
    const app = buildApp({ settings, logger: false, fetching: refusing });
    const routes = mutatingRoutesOf(app);
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      // Fastify knows one method more than its own injector does, and none of them is one this serves.
      const method = route.method as InjectOptions['method'];
      const response = await app.inject({ method, url: route.url, headers: current });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
    await app.close();
  });
});

describe('the application server', () => {
  it('reports itself healthy in the envelope every successful response takes', async () => {
    const { statusCode, body } = await served({ url: '/health' });
    expect(statusCode).toBe(200);
    expect(body).toEqual({
      data: { status: 'ok', locale: 'de' },
      meta: { requestId: expect.any(String), version: CLIENT_WINDOW.current },
    });
  });

  it('publishes the released message codes a client is allowed to depend on', async () => {
    const { statusCode, body } = await served({ url: '/api/contracts', headers: current });
    expect(statusCode).toBe(200);
    expect(body).toEqual({
      data: { clientVersions: [CLIENT_WINDOW.current], messageCodes: MESSAGE_CODES },
      meta: { requestId: expect.any(String), version: CLIENT_WINDOW.current },
    });
  });

  it('answers an unknown path in the error envelope, not with the web shell and not with Fastify\'s', async () => {
    const { statusCode, body } = await served({ url: '/nope', headers: current });
    expect(statusCode).toBe(404);
    expect(body).toEqual({
      error: { code: 'resource.not_found', message: expect.any(String), requestId: expect.any(String) },
    });
  });

  it('tells a client outside the compatibility window to update, before the route is reached', async () => {
    const stale = { [CLIENT_VERSION_HEADER]: '0' };
    const { statusCode, body } = await served({ url: '/api/contracts', headers: stale });
    expect(statusCode).toBe(426);
    expect(body).toEqual({
      error: {
        code: UPDATE_REQUIRED,
        message: UPDATE_REQUIRED_MESSAGE,
        requestId: expect.any(String),
        fields: [{ path: CLIENT_VERSION_HEADER, code: UPDATE_REQUIRED, message: `supported versions: ${CLIENT_WINDOW.current}` }],
      },
    });
  });

  it('tells a client that sends no version to update rather than guessing which contract it speaks', async () => {
    const { statusCode, body } = await served({ url: '/api/contracts' });
    expect(statusCode).toBe(426);
    expect((body as { error: { code: string } }).error.code).toBe(UPDATE_REQUIRED);
  });

  it('asks for a version on the API and nowhere else, because only an API client has one to send', async () => {
    expect(VERSIONED_PREFIX).toBe('/api/');
    expect((await served({ url: '/health' })).statusCode).toBe(200);
    expect((await served({ url: '/nope' })).statusCode).toBe(404);
  });

  it('still refuses an unsupported client on an API path that does not exist, before deciding it is missing', async () => {
    const { statusCode, body } = await served({ url: '/api/nope', headers: { [CLIENT_VERSION_HEADER]: '0' } });
    expect(statusCode).toBe(426);
    expect((body as { error: { code: string } }).error.code).toBe(UPDATE_REQUIRED);
  });

  it('carries the same policy headers on an API answer as on the client it serves', async () => {
    const app = buildApp({ settings, logger: false, fetching: refusing });
    const response = await app.inject({ method: 'GET', url: '/health' });
    await app.close();
    expect(response.headers['content-security-policy']).toBe(SECURITY_HEADERS['content-security-policy']);
  });
});

describe('the web client, served from the application own origin', () => {
  let dir: string;
  let assets: ReadonlyMap<string, WebAsset>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'holydeck-app-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html lang="en"><body><script type="module" src="/main.js"></script></body></html>');
    writeFileSync(join(dir, 'main.js'), 'export const ready = 1;\n');
    assets = readWebBuild(dir);
  });

  afterAll(() => rmSync(dir, { recursive: true }));

  const client = async (url: string): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }> => {
    const app = buildApp({ settings, logger: false, fetching: refusing, web: assets });
    try {
      const response = await app.inject({ method: 'GET', url });
      return { statusCode: response.statusCode, body: response.body, headers: response.headers };
    } finally {
      await app.close();
    }
  };

  it('answers the root with the shell, with no version header sent and none needed', async () => {
    const response = await client('/');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.body).toContain('src="/main.js"');
  });

  it('answers the assets the shell names on the same origin it was served from', async () => {
    const response = await client('/main.js');
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('export const ready = 1;\n');
  });

  it('names no other origin anywhere in what it serves, so a client makes no cross-origin request', async () => {
    for (const url of ['/', '/main.js']) {
      const { body } = await client(url);
      expect(body, url).not.toMatch(/\/\/[a-z0-9.-]+\.[a-z]{2,}/iu);
    }
  });

  it('serves no client at all where a deployment built none', async () => {
    const { statusCode, body } = await served({ url: '/' });
    expect(statusCode).toBe(404);
    expect((body as { error: { code: string } }).error.code).toBe('resource.not_found');
  });
});

describe('the translations the application reads from the library', () => {
  const list = [
    { abbreviation: 'KJV', id: 1, title: 'King James Version', language: 'English', syncedChapters: 1189, canonChapters: 1189, cached: true },
  ];

  const asked = async (
    settingsToUse: LoadedSettings,
    fetching: Fetching,
  ): Promise<{ statusCode: number; body: unknown }> => {
    const app = buildApp({ settings: settingsToUse, logger: false, fetching });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/translations', headers: current });
      return { statusCode: response.statusCode, body: response.json() };
    } finally {
      await app.close();
    }
  };

  it('answers what the library holds in the envelope every successful response takes', async () => {
    const { statusCode, body } = await asked(withCorpus, () =>
      Promise.resolve({ status: 200, json: () => Promise.resolve({ translations: list }) }),
    );
    expect(statusCode).toBe(200);
    expect(body).toEqual({
      data: { translations: list },
      meta: { requestId: expect.any(String), version: CLIENT_WINDOW.current },
    });
  });

  it('says the library is unavailable, in its own words, when the library refuses', async () => {
    const { statusCode, body } = await asked(withCorpus, () =>
      Promise.resolve({ status: 503, json: () => Promise.resolve({ error: { code: 'store_locked', message: 'the store at /data is locked' } }) }),
    );
    expect(statusCode).toBe(503);
    expect(body).toEqual({
      error: {
        code: 'corpus.unavailable',
        message: CORPUS_WORDING['corpus.unavailable'],
        requestId: expect.any(String),
      },
    });
    expect(JSON.stringify(body)).not.toContain('/data');
  });

  it('says so plainly where no library is configured, without asking anything', async () => {
    const { statusCode, body } = await asked(settings, refusing);
    expect(statusCode).toBe(503);
    expect((body as { error: { message: string } }).error.message)
      .toBe('No scripture library is configured for this deployment.');
  });

  it('is part of the versioned API, so a client too old to read it is told to update', async () => {
    const app = buildApp({ settings: withCorpus, logger: false, fetching: refusing });
    const response = await app.inject({ method: 'GET', url: '/api/v1/translations' });
    await app.close();
    expect(response.statusCode).toBe(426);
  });
});
