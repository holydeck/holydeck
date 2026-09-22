import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { get as getHttp } from 'node:http';
import { get as getHttps } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { loadSettings } from './settings.js';

import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';

const OPENSSL_AVAILABLE = spawnSync('openssl', ['version']).status === 0;

const httpsResponse = (url: string, ca: Buffer): Promise<{ readonly statusCode: number; readonly body: string }> =>
  new Promise((resolve, reject) => {
    const request = getHttps(url, { ca }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => resolve({ statusCode: response.statusCode ?? 0, body }));
    });
    request.once('error', reject);
  });

const plainHttpStatus = (url: string): Promise<number> =>
  new Promise((resolve) => {
    const request = getHttp(url, (response) => resolve(response.statusCode ?? 0));
    // A TLS listener closes a plain HTTP request before it can form an HTTP response, which is as
    // important a refusal as a non-200 response: a proxy accidentally configured for HTTP cannot pass.
    request.once('error', () => resolve(0));
  });

describe.skipIf(!OPENSSL_AVAILABLE)('an application with a certificate and key', () => {
  let app: FastifyInstance | undefined;
  let directory: string | undefined;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'holydeck-tls-'));
    const cert = join(directory, 'cert.pem');
    const key = join(directory, 'key.pem');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ]);

    app = buildApp({
      settings: loadSettings({}),
      logger: false,
      fetching: () => Promise.reject(new Error('nothing in this test may leave the process')),
      https: { cert: readFileSync(cert), key: readFileSync(key) },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    await app?.close();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  });

  it('answers its health route over HTTPS and never treats a plain request as healthy', async () => {
    const address = app?.server.address() as AddressInfo;
    const cert = join(directory as string, 'cert.pem');
    const https = await httpsResponse(`https://127.0.0.1:${address.port}/health`, readFileSync(cert));

    expect(https.statusCode).toBe(200);
    expect(JSON.parse(https.body).data.status).toBe('ok');
    expect(await plainHttpStatus(`http://127.0.0.1:${address.port}/health`)).not.toBe(200);
  });
});
