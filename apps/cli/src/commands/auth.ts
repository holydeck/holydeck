import { Command } from 'commander';
import { HolyDeckError } from '@holydeck/core/messages';
import { errLine, outLine } from '../context.js';
import type { CliContext } from '../context.js';
import {
  defaultOidcDependencies,
  loginOidc,
  readOidcSession,
  removeOidcSession,
} from '../oidc.js';
import type { OidcDependencies, OidcSession } from '../oidc.js';
import type { GlobalOptions } from '../program.js';
import { resolveRuntimeConfig, runtimeFlags } from '../runtime.js';

export interface AuthLoginOptions {
  issuer?: string;
  clientId?: string;
  audience?: string;
  resource?: string;
  scope?: string;
  callbackPort?: number;
}

function required(value: string | undefined, flag: string, environment: string): string {
  if (value === undefined || value.trim() === '') {
    throw new HolyDeckError('auth_failed', { reason: `pass ${flag} or set ${environment}` });
  }
  return value;
}

async function serverUrl(ctx: CliContext, globals: GlobalOptions): Promise<string> {
  const config = await resolveRuntimeConfig(ctx, runtimeFlags(globals));
  return required(config.values.serverUrl, '--server-url', 'HOLYDECK_SERVER_URL');
}

function publicSession(session: OidcSession): Omit<OidcSession, 'accessToken' | 'refreshToken' | 'tokenEndpoint'> & {
  refreshToken: boolean;
} {
  return {
    serverUrl: session.serverUrl,
    issuer: session.issuer,
    clientId: session.clientId,
    audience: session.audience,
    resource: session.resource,
    scope: session.scope,
    expiresAt: session.expiresAt,
    refreshToken: session.refreshToken !== undefined,
  };
}

export async function runAuthLogin(
  ctx: CliContext,
  options: AuthLoginOptions,
  globals: GlobalOptions,
  dependencies?: OidcDependencies,
): Promise<void> {
  const config = await resolveRuntimeConfig(ctx, {
    ...runtimeFlags(globals),
    oidcIssuer: options.issuer,
    oidcClientId: options.clientId,
    oidcAudience: options.audience,
    oidcResource: options.resource,
    oidcScope: options.scope,
    oidcCallbackPort: options.callbackPort,
  });
  const url = required(config.values.serverUrl, '--server-url', 'HOLYDECK_SERVER_URL');
  const issuer = required(config.values.oidcIssuer, '--issuer', 'HOLYDECK_OIDC_ISSUER');
  const clientId = required(config.values.oidcClientId, '--client-id', 'HOLYDECK_OIDC_CLIENT_ID');
  const deps = dependencies ?? defaultOidcDependencies({
    httpGet: ctx.httpGet,
    httpPost: ctx.httpPost,
    now: ctx.now,
    startCallback: ctx.startOidcCallback,
    openUrl: ctx.openUrl,
  });
  const session = await loginOidc(
    ctx.platform,
    {
      serverUrl: url,
      issuer,
      clientId,
      audience: config.values.oidcAudience,
      resource: config.values.oidcResource,
      scope: config.values.oidcScope,
      callbackPort: config.values.oidcCallbackPort,
      onAuthorizationUrl: (authorizationUrl, opened) => {
        errLine(ctx, opened ? `Opened ${authorizationUrl}` : `Open this URL in a browser: ${authorizationUrl}`);
      },
    },
    deps,
  );
  if (globals.json === true) {
    outLine(ctx, JSON.stringify({ authentication: publicSession(session) }, undefined, 2));
  } else {
    outLine(ctx, `Authenticated to ${session.serverUrl}; access token expires ${session.expiresAt}.`);
  }
}

export async function runAuthStatus(ctx: CliContext, globals: GlobalOptions): Promise<void> {
  const url = await serverUrl(ctx, globals);
  const session = await readOidcSession(ctx.platform, url);
  if (session === undefined) throw new HolyDeckError('auth_not_configured', { url });
  if (globals.json === true) {
    outLine(ctx, JSON.stringify({ authentication: publicSession(session) }, undefined, 2));
  } else {
    outLine(ctx, `Authenticated to ${session.serverUrl} via ${session.issuer}; access token expires ${session.expiresAt}.`);
  }
}

export async function runAuthLogout(ctx: CliContext, globals: GlobalOptions): Promise<void> {
  const url = await serverUrl(ctx, globals);
  const removed = await removeOidcSession(ctx.platform, url);
  outLine(ctx, removed ? `Removed the stored login for ${url}.` : `No stored login for ${url}.`);
}

export function registerAuth(program: Command, ctx: CliContext): void {
  const auth = program.command('auth').description('Authenticate to an OIDC-protected HolyDeck server');
  auth
    .command('login')
    .description('Sign in through a browser using Authorization Code + PKCE')
    .option('--issuer <url>', 'OIDC issuer URL (or HOLYDECK_OIDC_ISSUER)')
    .option('--client-id <id>', 'public OIDC client ID (or HOLYDECK_OIDC_CLIENT_ID)')
    .option('--audience <url>', 'access-token audience (or HOLYDECK_OIDC_AUDIENCE)')
    .option('--resource <url>', 'access-token resource prefix (or HOLYDECK_OIDC_RESOURCE)')
    .option('--scope <scope>', 'space-separated scopes (or HOLYDECK_OIDC_SCOPE)')
    .option('--callback-port <port>', 'loopback callback port', Number)
    .action(async (options: AuthLoginOptions, command: Command) => {
      await runAuthLogin(ctx, options, command.optsWithGlobals<GlobalOptions>());
    });
  auth
    .command('status')
    .description('Show the stored login without revealing tokens')
    .action(async (_options: Record<string, never>, command: Command) => {
      await runAuthStatus(ctx, command.optsWithGlobals<GlobalOptions>());
    });
  auth
    .command('logout')
    .description('Remove the locally stored login')
    .action(async (_options: Record<string, never>, command: Command) => {
      await runAuthLogout(ctx, command.optsWithGlobals<GlobalOptions>());
    });
}
