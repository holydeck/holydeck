import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HolyDeckError } from '@holydeck/core/messages';
import { makeContext } from '../../test/harness.js';
import { authFilePath, readOidcSession, saveOidcSession } from '../oidc.js';
import type { OidcDependencies, OidcSession } from '../oidc.js';
import { runCli } from '../program.js';
import { runAuthLogin, runAuthLogout, runAuthStatus } from './auth.js';

const serverUrl = 'https://api.example.com';
const issuer = 'https://auth.example.com';

function storedSession(): OidcSession {
  return {
    serverUrl,
    issuer,
    clientId: 'holydeck-cli',
    audience: serverUrl,
    resource: serverUrl,
    scope: 'offline_access authelia.bearer.authz',
    tokenEndpoint: `${issuer}/token`,
    accessToken: 'secret-access',
    refreshToken: 'secret-refresh',
    expiresAt: '2026-09-08T13:00:00.000Z',
  };
}

function loginDependencies(opened: boolean): OidcDependencies {
  return {
    now: () => new Date('2026-09-08T12:00:00.000Z'),
    random: (bytes) => Buffer.alloc(bytes, 1),
    httpGet: async () => ({
      status: 200,
      body: JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        pushed_authorization_request_endpoint: `${issuer}/par`,
      }),
    }),
    httpPost: async (url) =>
      url.endsWith('/par')
        ? { status: 201, body: JSON.stringify({ request_uri: 'urn:request:1' }) }
        : {
            status: 200,
            body: JSON.stringify({
              token_type: 'Bearer',
              access_token: 'secret-access',
              refresh_token: 'secret-refresh',
              expires_in: 3600,
            }),
          },
    startCallback: async (port) => ({
      redirectUri: `http://127.0.0.1:${port}/callback`,
      code: Promise.resolve('code'),
      close: async () => {},
    }),
    openUrl: async () => opened,
  };
}

describe('auth commands', () => {
  it('logs in with flags and prints only public session data as JSON', async () => {
    const setup = makeContext();
    await runAuthLogin(
      setup.ctx,
      { issuer, clientId: 'holydeck-cli' },
      { serverUrl, json: true },
      loginDependencies(true),
    );
    const output = JSON.parse(setup.stdout()) as { authentication: Record<string, unknown> };
    expect(output.authentication).toMatchObject({ serverUrl, issuer, clientId: 'holydeck-cli', refreshToken: true });
    expect(output.authentication).not.toHaveProperty('accessToken');
    expect(output.authentication).not.toHaveProperty('tokenEndpoint');
    expect(setup.stderr()).toContain('Opened https://auth.example.com/authorize');
    expect(readFileSync(authFilePath(setup.ctx.platform), 'utf8')).toContain('secret-access');
  });

  it('uses environment configuration, prints a manual URL and uses standard default scopes', async () => {
    const setup = makeContext({
      env: {
        HOLYDECK_SERVER_URL: serverUrl,
        HOLYDECK_OIDC_ISSUER: issuer,
        HOLYDECK_OIDC_CLIENT_ID: 'holydeck-cli',
        HOLYDECK_OIDC_RESOURCE: serverUrl,
      },
    });
    await runAuthLogin(setup.ctx, {}, {}, loginDependencies(false));
    expect(setup.stdout()).toContain(`Authenticated to ${serverUrl}`);
    expect(setup.stderr()).toContain('Open this URL in a browser:');
    expect(await readOidcSession(setup.ctx.platform, serverUrl)).toMatchObject({
      resource: serverUrl,
      scope: 'openid offline_access',
    });
    expect((await readOidcSession(setup.ctx.platform, serverUrl))?.audience).toBeUndefined();
  });

  it.each([
    [{}, {}, '--server-url'],
    [{ serverUrl }, {}, '--issuer'],
    [{ serverUrl }, { issuer }, '--client-id'],
  ])('reports missing setup values %#', async (globals, options, expected) => {
    const setup = makeContext();
    await expect(runAuthLogin(setup.ctx, options, globals, loginDependencies(true))).rejects.toThrow(expected);
  });

  it('shows status in human and JSON modes without exposing tokens', async () => {
    const human = makeContext();
    await saveOidcSession(human.ctx.platform, storedSession());
    await runAuthStatus(human.ctx, { serverUrl });
    expect(human.stdout()).toContain(`Authenticated to ${serverUrl} via ${issuer}`);
    expect(human.stdout()).not.toContain('secret-');

    const json = makeContext();
    await saveOidcSession(json.ctx.platform, storedSession());
    await runAuthStatus(json.ctx, { serverUrl, json: true });
    expect(JSON.parse(json.stdout()).authentication).toMatchObject({ refreshToken: true });
    expect(json.stdout()).not.toContain('secret-');
  });

  it('fails status without a login and makes logout idempotent', async () => {
    const setup = makeContext();
    await expect(runAuthStatus(setup.ctx, { serverUrl })).rejects.toBeInstanceOf(HolyDeckError);
    await runAuthLogout(setup.ctx, { serverUrl });
    expect(setup.stdout()).toContain('No stored login');
    await saveOidcSession(setup.ctx.platform, storedSession());
    await runAuthLogout(setup.ctx, { serverUrl });
    expect(setup.stdout()).toContain('Removed the stored login');
  });

  it('registers login, status and logout in the real command tree', async () => {
    const setup = makeContext({
      env: {
        HOLYDECK_SERVER_URL: serverUrl,
        HOLYDECK_OIDC_ISSUER: issuer,
        HOLYDECK_OIDC_CLIENT_ID: 'holydeck-cli',
      },
      responses: {
        [`${issuer}/.well-known/openid-configuration`]: {
          status: 200,
          body: JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            pushed_authorization_request_endpoint: `${issuer}/par`,
          }),
        },
        [`POST ${issuer}/par`]: { status: 201, body: JSON.stringify({ request_uri: 'urn:request:1' }) },
        [`POST ${issuer}/token`]: {
          status: 200,
          body: JSON.stringify({ token_type: 'Bearer', access_token: 'a', refresh_token: 'r', expires_in: 3600 }),
        },
      },
    });
    await expect(runCli(setup.ctx, ['auth', 'login'])).resolves.toBe(0);
    await expect(runCli(setup.ctx, ['auth', 'status', '--json'])).resolves.toBe(0);
    await expect(runCli(setup.ctx, ['auth', 'logout'])).resolves.toBe(0);
    expect(setup.openedUrls).toHaveLength(1);
  });
});
