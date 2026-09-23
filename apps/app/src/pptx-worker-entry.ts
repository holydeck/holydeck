// The code that actually runs inside a pptx-isolated.ts `workerPptxRunner` Worker (AUTH-13). Runs in its
// own V8 heap, under `resourceLimits`, so a crash or hang here cannot take down the app process that
// spawned it. `HolyDeckError` instances don't survive structured cloning with their custom fields intact,
// so every outcome — success or failure — crosses back out as a plain `{ ok, ... }` message the parent
// (pptx-isolated.ts) reconstructs a real `HolyDeckError` from.

import { parentPort, workerData } from 'node:worker_threads';

import { extractPptx } from '@holydeck/core/pptx';
import { HolyDeckError } from '@holydeck/core/messages';

import type { ExtractedPptx } from '@holydeck/core/pptx';
import type { MessageCode } from '@holydeck/core/messages';

export interface WorkerSuccessMessage {
  readonly ok: true;
  readonly result: ExtractedPptx;
}
export interface WorkerFailureMessage {
  readonly ok: false;
  readonly code: MessageCode;
  readonly params: Record<string, string | number>;
}
export type WorkerResultMessage = WorkerSuccessMessage | WorkerFailureMessage;

/** The pure part: turns uploaded bytes into the message to post back, whether extraction succeeded or
 *  threw. Exported and called directly by tests, so the error-shaping logic is covered without needing to
 *  spawn a real Worker for every case (pptx-isolated.test.ts already covers a real spawn end to end). */
export function extractForWorker(bytes: Uint8Array): WorkerResultMessage {
  try {
    return { ok: true, result: extractPptx(bytes) };
  } catch (error) {
    if (error instanceof HolyDeckError) return { ok: false, code: error.code, params: error.params };
    return { ok: false, code: 'pptx_corrupt', params: { reason: String(error) } };
  }
}

// Only run the actual worker boot glue when loaded as a real Worker (parentPort is null in the main
// thread, e.g. when a test imports extractForWorker directly).
if (parentPort !== null) {
  parentPort.postMessage(extractForWorker(workerData as Uint8Array));
}
