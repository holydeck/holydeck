// One running HolyDeck: a corpus, a migrated database, the application, and a worker, started the way a
// deployment starts them and reachable the way a client reaches them.
//
// Everything here is composition. The decisions — which port, which database, what a service is started
// with, what counts as ready, how a service is stopped — live in the modules beside this one, where each
// is graded on its own; what this file adds is the order, and the integration run grades that by using it.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applicationEnvironment, applicationMongoUrl, corpusEnvironment, workerEnvironment } from './environment.js';
import { mongoFor } from './mongo.js';
import { answers, portFor, ready, run, runOrThrow, serve } from './processes.js';
import { selfSignedCertificate, tlsEnvironment } from './tls.js';

import type { Addresses } from './environment.js';
import type { RunResult } from './processes.js';

export interface Stack {
  /** Where a client reaches the application, and through it everything the application serves. */
  readonly baseUrl: string;
  /** Where the library answers, so the suite can prove it refuses an uncredentialed request. */
  readonly corpusUrl: string;
  /** The application's own database, named, so a test can read what the application stored. */
  readonly mongoUrl: string;
  readonly dataDir: string;
  /** The certificate an HTTPS stack serves, and so the one authority a Node client trusts to reach it. */
  readonly certificateFile: string | undefined;
  /** Runs the worker's own health check, the same command the container is checked with. */
  workerHealth(): Promise<RunResult>;
  stop(): Promise<void>;
}

export interface StackOptions {
  /** A database to use instead of starting one, so this suite can be pointed at a deployed stack. */
  readonly mongoUrl?: string;
  /** A fixed application port, which the browser suite needs so its base URL is known up front. */
  readonly appPort?: number;
  /**
   * Serves the application over HTTPS with a certificate made for this run. The browser suite needs it:
   * the session cookie is `Secure`, and a browser signing in through the page only keeps it over HTTPS.
   */
  readonly tls?: boolean;
}

/** A built entry point, resolved from this file rather than from whatever directory the run started in. */
const entry = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

export async function startStack(options: StackOptions = {}): Promise<Stack> {
  const dataDir = mkdtempSync(join(tmpdir(), 'holydeck-harness-'));
  for (const directory of ['media', 'config']) mkdirSync(join(dataDir, directory), { recursive: true });

  const mongo = await mongoFor(options.mongoUrl);
  const stopped: Array<() => Promise<unknown>> = [() => mongo.stop()];
  const stop = async (): Promise<void> => {
    // Newest first: the worker and the application both hold the database open, and a database stopped
    // under a service that is still writing logs an error the run would have to explain away.
    for (const end of [...stopped].reverse()) await end();
    rmSync(dataDir, { recursive: true, force: true });
  };

  try {
    const addresses: Addresses = {
      appPort: await portFor(options.appPort),
      corpusPort: await portFor(undefined),
      mongoBase: mongo.base,
      dataDir,
    };
    const certificate = options.tls === true ? selfSignedCertificate(dataDir) : undefined;
    const ca = certificate === undefined ? undefined : readFileSync(certificate.certFile);
    const baseUrl = `${certificate === undefined ? 'http' : 'https'}://127.0.0.1:${addresses.appPort}`;
    const appEnvironment = {
      ...applicationEnvironment(addresses),
      ...(certificate === undefined ? {} : tlsEnvironment(certificate)),
    };
    const corpusUrl = `http://127.0.0.1:${addresses.corpusPort}`;

    const corpus = serve([entry('apps/corpus/dist/server.js')], corpusEnvironment(addresses));
    stopped.push(() => corpus.stop());
    await ready(corpus, 'the corpus', () => answers(`${corpusUrl}/health`));

    // The application refuses to serve an unmigrated database, so the migration is part of starting the
    // stack rather than something a test remembers to do.
    await runOrThrow([entry('apps/app/dist/migrate.js')], appEnvironment, 'the migration');

    const app = serve([entry('apps/app/dist/main.js')], appEnvironment);
    stopped.push(() => app.stop());
    await ready(app, 'the application', () => answers(`${baseUrl}/health`, ca));

    const worker = serve([entry('apps/worker/dist/main.js')], workerEnvironment(addresses));
    stopped.push(() => worker.stop());
    const heartbeat = join(dataDir, 'worker', 'heartbeat.json');
    await ready(worker, 'the worker', async () => existsSync(heartbeat));

    return {
      baseUrl,
      corpusUrl,
      mongoUrl: applicationMongoUrl(mongo.base),
      dataDir,
      certificateFile: certificate?.certFile,
      workerHealth: () => run([entry('apps/worker/dist/health.js')], workerEnvironment(addresses)),
      stop,
    };
  } catch (cause) {
    // A stack that failed half-way up still has services running and a directory on disk; leaving them
    // is how one failing run turns into every later one failing for a different reason.
    await stop();
    throw cause;
  }
}
