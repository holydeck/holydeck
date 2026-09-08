import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { configFilePath } from '@holydeck/core/config';
import type { PlatformInfo } from '@holydeck/core/config';
import type { HttpGet } from '@holydeck/core/fetcher';
import { HolyDeckError } from '@holydeck/core/messages';
import type { HttpPost } from './server-client.js';

const AUTH_VERSION = 1;
const DEFAULT_SCOPE = 'openid offline_access';
const EXPIRY_SKEW_MS = 30_000;

export interface OidcSession {
  serverUrl: string;
  issuer: string;
  clientId: string;
  audience?: string;
  resource?: string;
  scope: string;
  tokenEndpoint: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
}

interface AuthFile {
  version: 1;
  servers: Record<string, OidcSession>;
}

export interface OidcCallbackServer {
  redirectUri: string;
  code: Promise<string>;
  close: () => Promise<void>;
}

export interface OidcDependencies {
  httpGet: HttpGet;
  httpPost: HttpPost;
  now: () => Date;
  random: (bytes: number) => Buffer;
  startCallback: (port: number, state: string) => Promise<OidcCallbackServer>;
  openUrl: (url: string) => Promise<boolean>;
}

export interface OidcLoginOptions {
  serverUrl: string;
  issuer: string;
  clientId: string;
  audience?: string;
  resource?: string;
  scope?: string;
  callbackPort?: number;
  onAuthorizationUrl?: (url: string, opened: boolean) => void;
}

interface DiscoveryDocument {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  pushedAuthorizationRequestEndpoint?: string;
  responseModesSupported?: string[];
}

interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope?: string;
}

function fail(reason: string): never {
  throw new HolyDeckError('auth_failed', { reason });
}

function normalizeUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be an absolute URL`);
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) fail(`${label} must use http or https`);
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

function record(value: unknown, reason: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(reason);
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== 'string' || result === '') fail(`OIDC response field "${field}" is missing or invalid`);
  return result;
}

function optionalStringField(value: Record<string, unknown>, field: string): string | undefined {
  return value[field] === undefined ? undefined : stringField(value, field);
}

function optionalStringArrayField(value: Record<string, unknown>, field: string): string[] | undefined {
  const result = value[field];
  if (result === undefined) return undefined;
  if (!Array.isArray(result) || !result.every((item) => typeof item === 'string')) {
    fail(`OIDC response field "${field}" is invalid`);
  }
  return result;
}

function parseJson(body: string, label: string): Record<string, unknown> {
  try {
    return record(JSON.parse(body), `${label} is not a JSON object`);
  } catch (error) {
    if (error instanceof HolyDeckError) throw error;
    fail(`${label} is not valid JSON`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function responseError(body: string, fallback: string): string {
  try {
    const value = record(JSON.parse(body), fallback);
    const description = value['error_description'];
    if (typeof description === 'string' && description !== '') return description;
    const error = value['error'];
    if (typeof error === 'string' && error !== '') return error;
  } catch {
    // Use the status-based fallback when an OAuth endpoint did not return JSON.
  }
  return fallback;
}

function parseTokenResponse(body: string): TokenResponse {
  const value = parseJson(body, 'token response');
  const tokenType = stringField(value, 'token_type');
  if (tokenType.toLowerCase() !== 'bearer') fail(`unsupported token type "${tokenType}"`);
  const expiresIn = value['expires_in'];
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    fail('OIDC response field "expires_in" is missing or invalid');
  }
  const refreshToken = value['refresh_token'];
  const scope = value['scope'];
  if (refreshToken !== undefined && typeof refreshToken !== 'string') fail('OIDC response field "refresh_token" is invalid');
  if (scope !== undefined && typeof scope !== 'string') fail('OIDC response field "scope" is invalid');
  return {
    accessToken: stringField(value, 'access_token'),
    refreshToken,
    expiresIn,
    scope,
  };
}

export function authFilePath(platform: PlatformInfo): string {
  return join(dirname(configFilePath(platform)), 'auth.json');
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function parseSession(value: unknown, key: string): OidcSession {
  const item = record(value, `stored OIDC session for ${key} is invalid`);
  const refreshToken = item['refreshToken'];
  if (refreshToken !== undefined && typeof refreshToken !== 'string') fail(`stored OIDC session for ${key} is invalid`);
  return {
    serverUrl: stringField(item, 'serverUrl'),
    issuer: stringField(item, 'issuer'),
    clientId: stringField(item, 'clientId'),
    audience: optionalStringField(item, 'audience'),
    resource: optionalStringField(item, 'resource'),
    scope: stringField(item, 'scope'),
    tokenEndpoint: stringField(item, 'tokenEndpoint'),
    accessToken: stringField(item, 'accessToken'),
    refreshToken,
    expiresAt: stringField(item, 'expiresAt'),
  };
}

async function readAuthFile(platform: PlatformInfo): Promise<AuthFile> {
  const path = authFilePath(platform);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return { version: AUTH_VERSION, servers: {} };
    fail(`cannot read ${path}: ${errorMessage(error)}`);
  }
  const root = parseJson(text, `stored OIDC credentials at ${path}`);
  if (root['version'] !== AUTH_VERSION) fail(`stored OIDC credentials at ${path} use an unsupported version`);
  const servers = record(root['servers'], `stored OIDC credentials at ${path} have no server map`);
  return {
    version: AUTH_VERSION,
    servers: Object.fromEntries(Object.entries(servers).map(([key, value]) => [key, parseSession(value, key)])),
  };
}

async function writeAuthFile(platform: PlatformInfo, auth: AuthFile): Promise<void> {
  const path = authFilePath(platform);
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(auth, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function readOidcSession(platform: PlatformInfo, serverUrl: string): Promise<OidcSession | undefined> {
  const normalized = normalizeUrl(serverUrl, 'server URL');
  return (await readAuthFile(platform)).servers[normalized];
}

export async function saveOidcSession(platform: PlatformInfo, session: OidcSession): Promise<void> {
  const auth = await readAuthFile(platform);
  auth.servers[session.serverUrl] = session;
  await writeAuthFile(platform, auth);
}

export async function removeOidcSession(platform: PlatformInfo, serverUrl: string): Promise<boolean> {
  const normalized = normalizeUrl(serverUrl, 'server URL');
  const auth = await readAuthFile(platform);
  if (!(normalized in auth.servers)) return false;
  delete auth.servers[normalized];
  if (Object.keys(auth.servers).length === 0) {
    await unlink(authFilePath(platform));
    return true;
  }
  await writeAuthFile(platform, auth);
  return true;
}

async function discover(issuer: string, httpGet: HttpGet): Promise<DiscoveryDocument> {
  const url = `${issuer}/.well-known/openid-configuration`;
  let response: Awaited<ReturnType<HttpGet>>;
  try {
    response = await httpGet(url, { accept: 'application/json' });
  } catch (error) {
    fail(`cannot reach OIDC discovery at ${url}: ${errorMessage(error)}`);
  }
  if (response.status >= 400) fail(responseError(response.body, `OIDC discovery returned HTTP ${response.status}`));
  const value = parseJson(response.body, 'OIDC discovery response');
  const discoveredIssuer = normalizeUrl(stringField(value, 'issuer'), 'discovered issuer');
  if (discoveredIssuer !== issuer) fail(`discovery issuer mismatch: expected ${issuer}, received ${discoveredIssuer}`);
  return {
    issuer: discoveredIssuer,
    authorizationEndpoint: stringField(value, 'authorization_endpoint'),
    tokenEndpoint: stringField(value, 'token_endpoint'),
    pushedAuthorizationRequestEndpoint: optionalStringField(value, 'pushed_authorization_request_endpoint'),
    responseModesSupported: optionalStringArrayField(value, 'response_modes_supported'),
  };
}

async function postForm(httpPost: HttpPost, url: string, params: URLSearchParams, label: string): Promise<Record<string, unknown>> {
  let response: Awaited<ReturnType<HttpPost>>;
  try {
    response = await httpPost(url, params.toString(), {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    });
  } catch (error) {
    fail(`cannot reach ${label} at ${url}: ${errorMessage(error)}`);
  }
  if (response.status >= 400) fail(responseError(response.body, `${label} returned HTTP ${response.status}`));
  return parseJson(response.body, `${label} response`);
}

function expiresAt(now: Date, seconds: number): string {
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

export function defaultOidcDependencies(options: Omit<OidcDependencies, 'random'>): OidcDependencies {
  return { ...options, random: randomBytes };
}

export async function loginOidc(
  platform: PlatformInfo,
  options: OidcLoginOptions,
  dependencies: OidcDependencies,
): Promise<OidcSession> {
  const serverUrl = normalizeUrl(options.serverUrl, 'server URL');
  const issuer = normalizeUrl(options.issuer, 'issuer');
  const clientId = options.clientId.trim();
  if (clientId === '') fail('client ID must not be empty');
  const audience = options.audience === undefined ? undefined : normalizeUrl(options.audience, 'audience');
  const resource = options.resource === undefined ? undefined : normalizeUrl(options.resource, 'resource');
  const scope = options.scope?.trim() || DEFAULT_SCOPE;
  const callbackPort = options.callbackPort ?? 53682;
  if (!Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65535) fail('callback port must be between 1 and 65535');

  const discovery = await discover(issuer, dependencies.httpGet);
  const verifier = dependencies.random(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = dependencies.random(32).toString('base64url');
  const callback = await dependencies.startCallback(callbackPort, state);
  try {
    const responseMode = discovery.responseModesSupported?.includes('form_post') === true ? 'form_post' : 'query';
    const authorizationParams = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      response_mode: responseMode,
      redirect_uri: callback.redirectUri,
      scope,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    if (audience !== undefined) authorizationParams.set('audience', audience);
    if (resource !== undefined) authorizationParams.set('resource', resource);
    const authorizationUrl = new URL(discovery.authorizationEndpoint);
    if (discovery.pushedAuthorizationRequestEndpoint === undefined) {
      authorizationUrl.search = authorizationParams.toString();
    } else {
      const par = await postForm(
        dependencies.httpPost,
        discovery.pushedAuthorizationRequestEndpoint,
        authorizationParams,
        'pushed authorization endpoint',
      );
      const requestUri = stringField(par, 'request_uri');
      authorizationUrl.search = new URLSearchParams({ client_id: clientId, request_uri: requestUri }).toString();
    }
    let opened = false;
    try {
      opened = await dependencies.openUrl(authorizationUrl.toString());
    } catch {
      // The URL is still printed so the user can open it manually.
    }
    options.onAuthorizationUrl?.(authorizationUrl.toString(), opened);
    const code = await callback.code;
    const tokenValue = await postForm(
      dependencies.httpPost,
      discovery.tokenEndpoint,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: callback.redirectUri,
        code,
        code_verifier: verifier,
      }),
      'token endpoint',
    );
    const token = parseTokenResponse(JSON.stringify(tokenValue));
    const session: OidcSession = {
      serverUrl,
      issuer: discovery.issuer,
      clientId,
      audience,
      resource,
      scope: token.scope ?? scope,
      tokenEndpoint: discovery.tokenEndpoint,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: expiresAt(dependencies.now(), token.expiresIn),
    };
    await saveOidcSession(platform, session);
    return session;
  } finally {
    await callback.close();
  }
}

async function refreshOidcSession(
  platform: PlatformInfo,
  session: OidcSession,
  dependencies: Pick<OidcDependencies, 'httpPost' | 'now'>,
): Promise<OidcSession> {
  if (session.refreshToken === undefined) fail(`the access token for ${session.serverUrl} expired and no refresh token is stored`);
  const value = await postForm(
    dependencies.httpPost,
    session.tokenEndpoint,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: session.clientId,
      refresh_token: session.refreshToken,
    }),
    'token endpoint',
  );
  const token = parseTokenResponse(JSON.stringify(value));
  const refreshed: OidcSession = {
    ...session,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? session.refreshToken,
    scope: token.scope ?? session.scope,
    expiresAt: expiresAt(dependencies.now(), token.expiresIn),
  };
  await saveOidcSession(platform, refreshed);
  return refreshed;
}

export function createAccessTokenProvider(
  platform: PlatformInfo,
  serverUrl: string,
  dependencies: Pick<OidcDependencies, 'httpPost' | 'now'>,
): (forceRefresh?: boolean) => Promise<string | undefined> {
  return async (forceRefresh = false): Promise<string | undefined> => {
    const session = await readOidcSession(platform, serverUrl);
    if (session === undefined) return undefined;
    const validUntil = Date.parse(session.expiresAt);
    if (!forceRefresh && Number.isFinite(validUntil) && validUntil > dependencies.now().getTime() + EXPIRY_SKEW_MS) {
      return session.accessToken;
    }
    return (await refreshOidcSession(platform, session, dependencies)).accessToken;
  };
}
