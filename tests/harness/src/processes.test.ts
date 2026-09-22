import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { answers, freePort, portFor, ready, run, runOrThrow, serve } from './processes.js';
import { selfSignedCertificate } from './tls.js';

const NODE_ENV = {} as const;
const FOREVER = ['-e', 'setInterval(() => {}, 1000)'];
// It announces itself once the handler is installed, because a signal sent before that lands on a
// process that is not deaf yet, and the test would grade the wrong thing.
const DEAF = [
  '-e',
  'process.on("SIGTERM", () => {}); console.log("deaf"); setInterval(() => {}, 1000)',
];

const servers: Array<() => void> = [];

afterAll(() => {
  for (const close of servers) close();
});

/** A listening port, so `answers` can be asked about one that exists as well as one that does not. */
async function listening(): Promise<number> {
  const port = await freePort();
  const server = createServer((_request, response) => response.end('ok'));
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  servers.push(() => server.close());
  return port;
}

describe('the ports the harness runs its stack on', () => {
  it('finds one nothing is listening on', async () => {
    expect(await freePort()).toBeGreaterThan(1024);
  });

  it('uses the port it was given, and finds one when it was given none', async () => {
    expect(await portFor(31_415)).toBe(31_415);
    expect(await portFor(undefined)).toBeGreaterThan(1024);
  });
});

describe('running a command to completion', () => {
  it('carries back the exit code and everything the command wrote', async () => {
    const result = await run(['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'], NODE_ENV);
    expect(result.code).toBe(3);
    expect(result.output).toContain('out');
    expect(result.output).toContain('err');
  });

  it('returns quietly when the command succeeded', async () => {
    await expect(runOrThrow(['-e', 'process.exit(0)'], NODE_ENV, 'the quiet one')).resolves.toBeUndefined();
  });

  // A failed migration that the harness swallows would show up as an application refusing to start, three
  // steps later, with the reason nowhere in the output.
  it('refuses a command that failed, naming it and carrying what it wrote', async () => {
    await expect(
      runOrThrow(['-e', 'process.stderr.write("no database"); process.exit(1)'], NODE_ENV, 'the migration'),
    ).rejects.toThrow(/the migration exited with 1[\s\S]*no database/u);
  });
});

describe('waiting for a service to be ready', () => {
  it('knows an address that answers from one that does not', async () => {
    const port = await listening();
    expect(await answers(`http://127.0.0.1:${port}/`)).toBe(true);
    expect(await answers(`http://127.0.0.1:${await freePort()}/`)).toBe(false);
  });

  it.skipIf(spawnSync('openssl', ['version']).status !== 0)(
    'trusts an HTTPS stack through its own certificate, and only a successful answer',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'holydeck-answers-'));
      const certificate = selfSignedCertificate(directory);
      const ca = readFileSync(certificate.certFile);
      const server = createHttpsServer({ cert: ca, key: readFileSync(certificate.keyFile) }, (request, response) => {
        response.statusCode = request.url === '/health' ? 200 : 503;
        response.end();
      });
      const port = await freePort();
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
      try {
        expect(await answers(`https://127.0.0.1:${port}/health`, ca)).toBe(true);
        expect(await answers(`https://127.0.0.1:${port}/starting`, ca)).toBe(false);
        expect(await answers(`https://127.0.0.1:${await freePort()}/health`, ca)).toBe(false);
      } finally {
        server.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('returns as soon as the check passes', async () => {
    const served = serve(FOREVER, NODE_ENV);
    try {
      await expect(ready(served, 'the waiting one', async () => true)).resolves.toBeUndefined();
    } finally {
      await served.stop();
    }
  });

  it('refuses a service that exited before it was ready, with what it wrote', async () => {
    const served = serve(['-e', 'process.stderr.write("bad settings"); process.exit(2)'], NODE_ENV);
    await expect(ready(served, 'the application', async () => false)).rejects.toThrow(
      /the application exited with 2 before it was ready[\s\S]*bad settings/u,
    );
    await served.stop();
  });

  it('names the signal when the service was killed rather than exited', async () => {
    const served = serve(['-e', 'process.kill(process.pid, "SIGKILL")'], NODE_ENV);
    await expect(ready(served, 'the corpus', async () => false)).rejects.toThrow(
      'the corpus exited with SIGKILL before it was ready',
    );
    await served.stop();
  });

  it('gives up on a service that never becomes ready, saying how long it waited', async () => {
    const served = serve(FOREVER, NODE_ENV);
    try {
      await expect(
        ready(served, 'the worker', async () => false, { timeoutMs: 60, everyMs: 10 }),
      ).rejects.toThrow('the worker was not ready within 60ms');
    } finally {
      await served.stop();
    }
  });
});

describe('stopping a service', () => {
  it('kills one that ignores the signal to stop, once the grace has run out', async () => {
    const served = serve(DEAF, NODE_ENV, { graceMs: 100 });
    await ready(served, 'the deaf one', async () => served.output().includes('deaf'));
    await served.stop();
    expect(served.exit()).toMatchObject({ signal: 'SIGKILL' });
  });

  it('has nothing to do for one that has already exited', async () => {
    const served = serve(['-e', 'process.exit(0)'], NODE_ENV);
    await served.stopped();
    await expect(served.stop()).resolves.toBeUndefined();
    expect(served.exit()).toMatchObject({ code: 0 });
  });
});
