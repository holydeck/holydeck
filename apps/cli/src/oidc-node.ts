import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OidcCallbackServer } from './oidc.js';

type Spawn = typeof spawn;

export async function openExternalUrl(
  url: string,
  /* v8 ignore next -- production platform default; command selection is tested explicitly */
  platform: NodeJS.Platform = process.platform,
  /* v8 ignore next -- production process adapter; injected spawns are tested explicitly */
  spawnProcess: Spawn = spawn,
): Promise<boolean> {
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return await new Promise<boolean>((resolve) => {
    const child = spawnProcess(command, args, { detached: true, stdio: 'ignore' });
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
    child.once('error', () => resolve(false));
  });
}

function callbackValues(req: IncomingMessage, body: string): URLSearchParams {
  if (req.method === 'POST') return new URLSearchParams(body);
  return new URL(req.url as string, 'http://127.0.0.1').searchParams;
}

function respond(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
  res.end(`<!doctype html><title>HolyDeck</title><p>${message}</p>`);
}

export async function startLoopbackCallback(
  requestedPort: number,
  expectedState: string,
  timeoutMs = 120_000,
): Promise<OidcCallbackServer> {
  let settled = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  void code.catch(() => {});

  const server = createServer((req, res) => {
    if ((req.url as string).split('?')[0] !== '/callback' || !['GET', 'POST'].includes(req.method as string)) {
      respond(res, 404, 'Not found.');
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > 16_384) req.destroy();
    });
    req.on('end', () => {
      const params = callbackValues(req, body);
      if (params.get('state') !== expectedState) {
        respond(res, 400, 'Authentication state did not match. Return to the terminal and try again.');
        return;
      }
      const oauthError = params.get('error');
      if (oauthError !== null) {
        const description = params.get('error_description');
        respond(res, 400, 'Authentication was not completed. You can close this window.');
        settled = true;
        clearTimeout(timer);
        rejectCode(new Error(description === null ? oauthError : `${oauthError}: ${description}`));
        return;
      }
      const authorizationCode = params.get('code');
      if (authorizationCode === null || authorizationCode === '') {
        respond(res, 400, 'No authorization code was returned. Return to the terminal and try again.');
        return;
      }
      respond(res, 200, 'Authentication complete. You can close this window and return to HolyDeck.');
      settled = true;
      clearTimeout(timer);
      resolveCode(authorizationCode);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const timer = setTimeout(() => {
    settled = true;
    rejectCode(new Error('timed out waiting for the browser callback'));
  }, timeoutMs);
  timer.unref();

  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    code,
    close: async () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        rejectCode(new Error('browser callback listener closed'));
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
