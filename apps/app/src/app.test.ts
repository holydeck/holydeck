import { CLIENT_VERSION_HEADER, CLIENT_WINDOW, UPDATE_REQUIRED_MESSAGE } from '@holydeck/contracts/clients';
import { MESSAGE_CODES, UPDATE_REQUIRED } from '@holydeck/contracts/http';
import { describe, expect, it } from 'vitest';

import { PUBLIC_PATHS, buildApp } from './app.js';
import { DEFAULT_SETTINGS, type LoadedSettings } from './settings.js';

const settings: LoadedSettings = {
  values: { ...DEFAULT_SETTINGS, locale: 'de' },
  sources: { port: 'default', dataDir: 'default', mediaRoot: 'default', locale: 'file' },
  path: '/data/holydeck/config/settings.yaml',
};

const served = async (
  request: { url: string; headers?: Record<string, string> },
): Promise<{ statusCode: number; body: unknown }> => {
  const app = buildApp({ settings, logger: false });
  try {
    const response = await app.inject({ method: 'GET', url: request.url, headers: request.headers });
    return { statusCode: response.statusCode, body: response.json() };
  } finally {
    await app.close();
  }
};

const current = { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current) };

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

  it('serves the paths a health probe uses without a client version, because a probe is not a client', async () => {
    expect(PUBLIC_PATHS).toEqual(['/health']);
    const { statusCode } = await served({ url: '/health' });
    expect(statusCode).toBe(200);
  });

  it('still refuses an unsupported client on a path that does not exist, before deciding it is missing', async () => {
    const { statusCode, body } = await served({ url: '/nope', headers: { [CLIENT_VERSION_HEADER]: '0' } });
    expect(statusCode).toBe(426);
    expect((body as { error: { code: string } }).error.code).toBe(UPDATE_REQUIRED);
  });
});
