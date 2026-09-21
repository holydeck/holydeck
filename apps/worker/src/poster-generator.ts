import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import type { PosterGenerator } from './media-ingest.js';

/**
 * THR-07: bounds ffmpeg by wall clock, independent of the caller's own signal. A lease can be lost and
 * abort this the same as before; a malformed or adversarial file that neither finishes nor aborts is
 * killed anyway, once this much real time has passed against it.
 */
export const FFMPEG_TIMEOUT_MS = 30_000;

const runFfmpeg = (source: string, poster: string, signal: AbortSignal, timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-y', '-i', source, '-frames:v', '1', poster], { stdio: 'ignore' });
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const abort = (): void => {
      child.kill();
    };
    bounded.addEventListener('abort', abort, { once: true });
    child.once('error', reject);
    child.once('close', (code) => {
      bounded.removeEventListener('abort', abort);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${String(code)}`));
    });
  });

export interface FfmpegPosterGeneratorOptions {
  /** Overridable only for a test that cannot wait out the real ceiling. Every deployment gets the same one. */
  readonly timeoutMs?: number;
}

/** The production decoder: ffmpeg runs outside the process and no media codec is bundled into JavaScript. */
export function ffmpegPosterGenerator(options: FfmpegPosterGeneratorOptions = {}): PosterGenerator {
  const timeoutMs = options.timeoutMs ?? FFMPEG_TIMEOUT_MS;
  return {
    async generate(bytes, signal) {
      const directory = await mkdtemp(join(tmpdir(), 'holydeck-media-'));
      const source = join(directory, `${randomUUID()}.mp4`);
      const poster = join(directory, `${randomUUID()}.jpg`);
      try {
        await writeFile(source, bytes);
        await runFfmpeg(source, poster, signal, timeoutMs);
        return new Uint8Array(await readFile(poster));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
