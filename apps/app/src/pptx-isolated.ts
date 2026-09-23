// AUTH-13's isolation boundary: PPTX parsing (packages/core's extractPptx) is CPU-bound XML/ZIP work over
// bytes an operator uploaded, and openArchive's own limits (pptx.ts) bound the common hostile-archive
// cases but cannot bound every possible parser bug or pathological input. Running extraction inside a
// real node:worker_threads Worker, with its own resourceLimits and a hard timeout, means a crash or hang
// inside the parser takes down that one Worker's heap, not the main app process serving every other
// request. inProcessPptxRunner keeps the direct, un-isolated call available for tests that already
// exercise parsing itself and don't need a real OS thread to prove it works.

import { Worker } from 'node:worker_threads';

import { extractPptx } from '@holydeck/core/pptx';
import { HolyDeckError } from '@holydeck/core/messages';

import type { ExtractedPptx } from '@holydeck/core/pptx';
import type { MessageCode } from '@holydeck/core/messages';

export interface IsolatedPptxRunner {
  run(bytes: Uint8Array): Promise<ExtractedPptx>;
}

/** Runs extraction in-process, with no isolation. Used by unit/store tests, which already exercise the
 *  parsing logic directly against packages/core and don't need a real OS thread to verify it. */
export function inProcessPptxRunner(): IsolatedPptxRunner {
  return { run: async (bytes) => extractPptx(bytes) };
}

export interface WorkerPptxRunnerOptions {
  readonly timeoutMs?: number;
  readonly maxOldGenerationSizeMb?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OLD_GENERATION_MB = 512;

interface WorkerSuccess {
  readonly ok: true;
  readonly result: ExtractedPptx;
}
interface WorkerFailure {
  readonly ok: false;
  readonly code: MessageCode;
  readonly params: Record<string, string | number>;
}
type WorkerResponse = WorkerSuccess | WorkerFailure;

const isWorkerResponse = (value: unknown): value is WorkerResponse =>
  typeof value === 'object' && value !== null && 'ok' in value;

// import.meta.url ends in `.ts` when this module runs straight from source (vitest, or Node's own native
// TypeScript support under Node >=24) and in `.js` once tsup has compiled it to apps/app/dist/ — either
// way, the sibling worker-entry file this resolves to is the one apps/app/tsup.config.ts's own `entry`
// array guarantees exists next to it.
const WORKER_ENTRY_URL = new URL(
  import.meta.url.endsWith('.ts') ? './pptx-worker-entry.ts' : './pptx-worker-entry.js',
  import.meta.url,
);

/** Runs extraction inside a real node:worker_threads Worker with resource limits, so a hostile or
 *  malformed archive cannot crash or hang the main app process. Wired in production (main.ts). */
export function workerPptxRunner(options: WorkerPptxRunnerOptions = {}): IsolatedPptxRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOldGenerationSizeMb = options.maxOldGenerationSizeMb ?? DEFAULT_MAX_OLD_GENERATION_MB;
  return {
    run(bytes) {
      return new Promise<ExtractedPptx>((resolve, reject) => {
        const worker = new Worker(WORKER_ENTRY_URL, {
          workerData: bytes,
          resourceLimits: { maxOldGenerationSizeMb },
        });
        let settled = false;
        const finish = (act: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          act();
          void worker.terminate();
        };
        const timer = setTimeout(() => {
          finish(() => reject(new HolyDeckError('pptx_corrupt', { reason: 'timed out' })));
        }, timeoutMs);
        worker.once('message', (message: unknown) => {
          finish(() => {
            if (!isWorkerResponse(message)) {
              reject(new HolyDeckError('pptx_corrupt', { reason: 'the isolated import failed' }));
              return;
            }
            if (message.ok) {
              resolve(message.result);
            } else {
              reject(new HolyDeckError(message.code, message.params));
            }
          });
        });
        worker.once('error', () => {
          finish(() => reject(new HolyDeckError('pptx_corrupt', { reason: 'the isolated import failed' })));
        });
        worker.once('exit', (code) => {
          finish(() =>
            reject(new HolyDeckError('pptx_corrupt', { reason: `the isolated import exited unexpectedly (code ${code})` })),
          );
        });
      });
    },
  };
}
