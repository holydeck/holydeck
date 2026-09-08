import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PlatformInfo } from '@holydeck/core/config';
import { HolyDeckError } from '@holydeck/core/messages';
import {
  authFilePath,
  createAccessTokenProvider,
  defaultOidcDependencies,
  loginOidc,
  readOidcSession,
  removeOidcSession,
  saveOidcSession,
} from './oidc.js';
import type { OidcDependencies, OidcSession } from './oidc.js';

const issuer = 'https://auth.example.com';
const serverUrl = 'https://api.example.com';
const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
const discovery = JSON.stringify({
  issuer,
  authorization_endpoint: `${issuer}/api/oidc/authorization`,
  token_endpoint: `${issuer}/api/oidc/token`,
  pushed_authorization_request_endpoint: `${issuer}/api/oidc/pushed-authorization-request`,
  response_modes_supported: ['query', 'form_post'],
});

function platform(): PlatformInfo {
  const homeDir = mkdtempSync(join(tmpdir(), 'holydeck-oidc-'));
  return { platform: 'linux', env: { XDG_CONFIG_HOME: join(homeDir, 'config') }, homeDir };
}

function session(overrides: Partial<OidcSession> = {}): OidcSession {
  return {
    serverUrl,
    issuer,
    clientId: 'holydeck-cli',
    audience: serverUrl,
    resource: serverUrl,
    scope: 'offline_access authelia.bearer.authz',
    tokenEndpoint: `${issuer}/api/oidc/token`,
    accessToken: 'access-one',
    refreshToken: 'refresh-one',
    expiresAt: '2026-09-08T13:00:00.000Z',
    ...overrides,
  };
}

function dependencies(options: {
  get?: Record<string, { status: number; body: string }>;
  post?: Record<string, { status: number; body: string }>;
  callbackCode?: Promise<string>;
  open?: boolean | Error;
} = {}): OidcDependencies & { gets: string[]; posts: Array<{ url: string; body: string; headers: Record<string, string> }>; closed: ReturnType<typeof vi.fn> } {
  const gets: string[] = [];
  const posts: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const closed = vi.fn().mockResolvedValue(undefined);
  let randomCall = 0;
  return {
    gets,
    posts,
    closed,
    now: () => new Date('2026-09-08T12:00:00.000Z'),
    random: (bytes) => Buffer.alloc(bytes, ++randomCall),
    httpGet: async (url) => {
      gets.push(url);
      const response = options.get?.[url];
      if (!response) throw new Error(`missing GET ${url}`);
      return response;
    },
    httpPost: async (url, body, headers) => {
      posts.push({ url, body, headers });
      const response = options.post?.[url];
      if (!response) throw new Error(`missing POST ${url}`);
      return response;
    },
    startCallback: async (port, state) => ({
      redirectUri: `http://127.0.0.1:${port}/callback`,
      code: options.callbackCode ?? Promise.resolve(`code-${state}`),
      close: closed,
    }),
    openUrl: async () => {
      if (options.open instanceof Error) throw options.open;
      return options.open ?? true;
    },
  };
}

function loginDependencies(options: Parameters<typeof dependencies>[0] = {}) {
  return dependencies({
    get: { [discoveryUrl]: { status: 200, body: discovery }, ...options.get },
    post: {
      [`${issuer}/api/oidc/pushed-authorization-request`]: {
        status: 201,
        body: JSON.stringify({ request_uri: 'urn:ietf:params:oauth:request_uri:abc', expires_in: 90 }),
      },
      [`${issuer}/api/oidc/token`]: {
        status: 200,
        body: JSON.stringify({
          token_type: 'Bearer',
          access_token: 'access-one',
          refresh_token: 'refresh-one',
          expires_in: 3600,
          scope: 'offline_access authelia.bearer.authz',
        }),
      },
      ...options.post,
    },
    callbackCode: options.callbackCode,
    open: options.open,
  });
}

describe('OIDC login', () => {
  it('uses discovery, PAR, PKCE and the code exchange, then stores mode-0600 credentials', async () => {
    const target = platform();
    const deps = loginDependencies();
    const authorization = vi.fn();
    const result = await loginOidc(
      target,
      {
        serverUrl: `${serverUrl}/`,
        issuer: `${issuer}/`,
        clientId: ' holydeck-cli ',
        audience: serverUrl,
        resource: `${serverUrl}/`,
        scope: 'offline_access authelia.bearer.authz',
        onAuthorizationUrl: authorization,
      },
      deps,
    );

    expect(result).toEqual(session());
    expect(deps.gets).toEqual([discoveryUrl]);
    expect(deps.posts).toHaveLength(2);
    const par = new URLSearchParams(deps.posts[0]?.body);
    expect(par.get('client_id')).toBe('holydeck-cli');
    expect(par.get('response_type')).toBe('code');
    expect(par.get('response_mode')).toBe('form_post');
    expect(par.get('redirect_uri')).toBe('http://127.0.0.1:53682/callback');
    expect(par.get('scope')).toBe('offline_access authelia.bearer.authz');
    expect(par.get('audience')).toBe(serverUrl);
    expect(par.get('resource')).toBe(serverUrl);
    expect(par.get('code_challenge_method')).toBe('S256');
    expect(par.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const token = new URLSearchParams(deps.posts[1]?.body);
    expect(token.get('grant_type')).toBe('authorization_code');
    expect(token.get('code')).toMatch(/^code-/);
    expect(token.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(deps.posts.every((post) => post.headers['content-type'] === 'application/x-www-form-urlencoded')).toBe(true);
    expect(authorization).toHaveBeenCalledWith(
      `${issuer}/api/oidc/authorization?client_id=holydeck-cli&request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Aabc`,
      true,
    );
    expect(deps.closed).toHaveBeenCalledOnce();
    expect(await readOidcSession(target, `${serverUrl}/`)).toEqual(session());
    expect(statSync(authFilePath(target)).mode & 0o777).toBe(0o600);
  });

  it('supports explicit audience, scope and callback port, plus a provider that omits refresh/scope', async () => {
    const target = platform();
    const deps = loginDependencies({
      post: {
        [`${issuer}/api/oidc/token`]: {
          status: 200,
          body: JSON.stringify({ token_type: 'bearer', access_token: 'short', expires_in: 60 }),
        },
      },
      open: new Error('no browser'),
    });
    const authorization = vi.fn();
    const result = await loginOidc(
      target,
      {
        serverUrl,
        issuer,
        clientId: 'client',
        audience: 'https://resource.example.com/path/',
        resource: 'https://resource.example.com/api/',
        scope: ' offline_access ',
        callbackPort: 4567,
        onAuthorizationUrl: authorization,
      },
      deps,
    );
    expect(result.audience).toBe('https://resource.example.com/path');
    expect(result.resource).toBe('https://resource.example.com/api');
    expect(result.scope).toBe('offline_access');
    expect(result.refreshToken).toBeUndefined();
    expect(result.expiresAt).toBe('2026-09-08T12:01:00.000Z');
    expect(authorization).toHaveBeenCalledWith(expect.any(String), false);
  });

  it('uses a standard authorization request when discovery does not advertise PAR', async () => {
    const target = platform();
    const noParDiscovery = JSON.stringify({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
    });
    const deps = dependencies({
      get: { [discoveryUrl]: { status: 200, body: noParDiscovery } },
      post: {
        [`${issuer}/token`]: {
          status: 200,
          body: JSON.stringify({ token_type: 'Bearer', access_token: 'access', refresh_token: 'refresh', expires_in: 60 }),
        },
      },
    });
    const authorization = vi.fn();
    const result = await loginOidc(
      target,
      { serverUrl, issuer, clientId: 'generic-cli', onAuthorizationUrl: authorization },
      deps,
    );

    const url = new URL(authorization.mock.calls[0]?.[0] as string);
    expect(url.origin + url.pathname).toBe(`${issuer}/authorize`);
    expect(url.searchParams.get('response_mode')).toBe('query');
    expect(url.searchParams.get('scope')).toBe('openid offline_access');
    expect(url.searchParams.has('audience')).toBe(false);
    expect(deps.posts).toHaveLength(1);
    expect(result).toMatchObject({ scope: 'openid offline_access' });
    expect(result.audience).toBeUndefined();
  });

  it.each([
    [{ serverUrl: 'relative', issuer, clientId: 'x' }, 'server URL must be an absolute URL'],
    [{ serverUrl, issuer: 'ftp://auth.example.com', clientId: 'x' }, 'issuer must use http or https'],
    [{ serverUrl, issuer, clientId: '   ' }, 'client ID must not be empty'],
    [{ serverUrl, issuer, clientId: 'x', resource: 'relative' }, 'resource must be an absolute URL'],
    [{ serverUrl, issuer, clientId: 'x', callbackPort: 0 }, 'callback port must be between'],
    [{ serverUrl, issuer, clientId: 'x', callbackPort: 65536 }, 'callback port must be between'],
  ])('rejects invalid login options %#', async (options, message) => {
    await expect(loginOidc(platform(), options, loginDependencies())).rejects.toThrow(message);
  });

  it('always closes the callback server when PAR or callback processing fails', async () => {
    const parFailure = loginDependencies({
      post: {
        [`${issuer}/api/oidc/pushed-authorization-request`]: {
          status: 400,
          body: JSON.stringify({ error: 'invalid_request', error_description: 'bad redirect' }),
        },
      },
    });
    await expect(loginOidc(platform(), { serverUrl, issuer, clientId: 'x' }, parFailure)).rejects.toThrow('bad redirect');
    expect(parFailure.closed).toHaveBeenCalledOnce();

    const callbackFailure = loginDependencies({ callbackCode: Promise.reject(new Error('callback denied')) });
    await expect(loginOidc(platform(), { serverUrl, issuer, clientId: 'x' }, callbackFailure)).rejects.toThrow('callback denied');
    expect(callbackFailure.closed).toHaveBeenCalledOnce();
  });
});

describe('OIDC endpoint validation', () => {
  it.each([
    [{ status: 500, body: JSON.stringify({ error: 'temporarily_unavailable' }) }, 'temporarily_unavailable'],
    [{ status: 500, body: JSON.stringify({ error: '' }) }, 'HTTP 500'],
    [{ status: 500, body: '<html>down</html>' }, 'HTTP 500'],
    [{ status: 200, body: 'not-json' }, 'not valid JSON'],
    [{ status: 200, body: '[]' }, 'not a JSON object'],
    [{ status: 200, body: JSON.stringify({ issuer: 'https://wrong.example.com' }) }, 'issuer mismatch'],
    [{ status: 200, body: JSON.stringify({ issuer }) }, 'authorization_endpoint'],
    [
      {
        status: 200,
        body: JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          response_modes_supported: 'query',
        }),
      },
      'response_modes_supported',
    ],
  ])('rejects bad discovery %#', async (response, message) => {
    const deps = dependencies({ get: { [discoveryUrl]: response } });
    await expect(loginOidc(platform(), { serverUrl, issuer, clientId: 'x' }, deps)).rejects.toThrow(message);
  });

  it('maps discovery and token transport errors', async () => {
    const discoveryFailure = dependencies();
    await expect(loginOidc(platform(), { serverUrl, issuer, clientId: 'x' }, discoveryFailure)).rejects.toThrow(
      'cannot reach OIDC discovery',
    );

    const nonErrorFailure = dependencies();
    nonErrorFailure.httpGet = async () => {
      throw 'offline';
    };
    await expect(loginOidc(platform(), { serverUrl, issuer, clientId: 'x' }, nonErrorFailure)).rejects.toThrow('offline');

    const tokenFailure = loginDependencies({ post: { [`${issuer}/api/oidc/token`]: undefined as never } });
    await expect(loginOidc(platform(), { serverUrl, issuer, clientId: 'x' }, tokenFailure)).rejects.toThrow(
      'cannot reach token endpoint',
    );
  });

  it.each([
    [{ token_type: 'MAC', access_token: 'x', expires_in: 60 }, 'unsupported token type'],
    [{ token_type: 'Bearer', access_token: 'x', expires_in: 0 }, 'expires_in'],
    [{ token_type: 'Bearer', access_token: 'x', expires_in: Number.POSITIVE_INFINITY }, 'expires_in'],
    [{ token_type: 'Bearer', expires_in: 60 }, 'access_token'],
    [{ token_type: 'Bearer', access_token: 'x', expires_in: 60, refresh_token: 7 }, 'refresh_token'],
    [{ token_type: 'Bearer', access_token: 'x', expires_in: 60, scope: 7 }, 'scope'],
  ])('rejects malformed token response %#', async (token, message) => {
    const deps = loginDependencies({
      post: { [`${issuer}/api/oidc/token`]: { status: 200, body: JSON.stringify(token) } },
    });
    await expect(loginOidc(platform(), { serverUrl, issuer, clientId: 'x' }, deps)).rejects.toThrow(message);
  });
});

describe('OIDC credential store and refresh', () => {
  it('returns no token without a login and keeps logout idempotent', async () => {
    const target = platform();
    const provider = createAccessTokenProvider(target, `${serverUrl}/`, {
      httpPost: async () => {
        throw new Error('unused');
      },
      now: () => new Date('2026-09-08T12:00:00.000Z'),
    });
    await expect(provider()).resolves.toBeUndefined();
    await expect(removeOidcSession(target, serverUrl)).resolves.toBe(false);
  });

  it('returns a valid cached token without calling the token endpoint', async () => {
    const target = platform();
    await saveOidcSession(target, session());
    const post = vi.fn();
    const provider = createAccessTokenProvider(target, serverUrl, {
      httpPost: post,
      now: () => new Date('2026-09-08T12:00:00.000Z'),
    });
    await expect(provider()).resolves.toBe('access-one');
    expect(post).not.toHaveBeenCalled();
  });

  it.each([false, true])('refreshes an expired or forcibly invalidated token (forced=%s)', async (force) => {
    const target = platform();
    await saveOidcSession(target, session({ expiresAt: force ? '2026-09-08T13:00:00.000Z' : 'invalid' }));
    const posts: string[] = [];
    const provider = createAccessTokenProvider(target, serverUrl, {
      httpPost: async (_url, body) => {
        posts.push(body);
        return {
          status: 200,
          body: JSON.stringify({ token_type: 'Bearer', access_token: 'access-two', expires_in: 7200 }),
        };
      },
      now: () => new Date('2026-09-08T12:00:00.000Z'),
    });
    await expect(provider(force)).resolves.toBe('access-two');
    expect(new URLSearchParams(posts[0]).get('refresh_token')).toBe('refresh-one');
    expect(await readOidcSession(target, serverUrl)).toEqual(
      session({ accessToken: 'access-two', expiresAt: '2026-09-08T14:00:00.000Z' }),
    );
  });

  it('rotates refresh tokens and accepts a changed scope', async () => {
    const target = platform();
    await saveOidcSession(target, session({ expiresAt: '2026-09-08T11:00:00.000Z' }));
    const provider = createAccessTokenProvider(target, serverUrl, {
      httpPost: async () => ({
        status: 200,
        body: JSON.stringify({
          token_type: 'Bearer',
          access_token: 'access-two',
          refresh_token: 'refresh-two',
          expires_in: 60,
          scope: 'authelia.bearer.authz',
        }),
      }),
      now: () => new Date('2026-09-08T12:00:00.000Z'),
    });
    await provider();
    expect(await readOidcSession(target, serverUrl)).toMatchObject({
      refreshToken: 'refresh-two',
      scope: 'authelia.bearer.authz',
    });
  });

  it('fails clearly when an expired login has no refresh token', async () => {
    const target = platform();
    await saveOidcSession(target, session({ refreshToken: undefined, expiresAt: '2026-09-08T11:00:00.000Z' }));
    const provider = createAccessTokenProvider(target, serverUrl, {
      httpPost: vi.fn(),
      now: () => new Date('2026-09-08T12:00:00.000Z'),
    });
    await expect(provider()).rejects.toThrow('no refresh token');
  });

  it('stores multiple servers and removes only the selected one', async () => {
    const target = platform();
    await saveOidcSession(target, session());
    await saveOidcSession(target, session({ serverUrl: 'https://other.example.com', accessToken: 'other' }));
    await expect(removeOidcSession(target, serverUrl)).resolves.toBe(true);
    expect(await readOidcSession(target, 'https://other.example.com')).toMatchObject({ accessToken: 'other' });
    await expect(removeOidcSession(target, 'https://other.example.com')).resolves.toBe(true);
    expect(() => readFileSync(authFilePath(target))).toThrow();
  });

  it('surfaces unreadable and malformed stores', async () => {
    const cases = [
      'not json',
      '[]',
      JSON.stringify({ version: 2, servers: {} }),
      JSON.stringify({ version: 1 }),
      JSON.stringify({ version: 1, servers: { [serverUrl]: [] } }),
      JSON.stringify({ version: 1, servers: { [serverUrl]: { serverUrl, refreshToken: 7 } } }),
    ];
    for (const value of cases) {
      const target = platform();
      mkdirSync(dirname(authFilePath(target)), { recursive: true });
      writeFileSync(authFilePath(target), value);
      await expect(readOidcSession(target, serverUrl)).rejects.toBeInstanceOf(HolyDeckError);
    }

    const target = platform();
    mkdirSync(dirname(authFilePath(target)), { recursive: true });
    mkdirSync(authFilePath(target));
    await expect(readOidcSession(target, serverUrl)).rejects.toThrow('cannot read');
    chmodSync(authFilePath(target), 0o700);
  });

  it('provides cryptographic randomness by default', () => {
    const deps = defaultOidcDependencies({
      httpGet: vi.fn(),
      httpPost: vi.fn(),
      now: () => new Date(),
      startCallback: vi.fn(),
      openUrl: vi.fn(),
    });
    expect(deps.random(32)).toHaveLength(32);
  });
});
