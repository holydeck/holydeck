import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import type { PosterGenerator } from './media-ingest.js';

const runFfmpeg = (source: string, poster: string, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-y', '-i', source, '-frames:v', '1', poster], { stdio: 'ignore' });
    const abort = (): void => {
      child.kill();
    };
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', reject);
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${String(code)}`));
    });
  });

/** The production decoder: ffmpeg runs outside the process and no media codec is bundled into JavaScript. */
export function ffmpegPosterGenerator(): PosterGenerator {
  return {
    async generate(bytes, signal) {
      const directory = await mkdtemp(join(tmpdir(), 'holydeck-media-'));
      const source = join(directory, `${randomUUID()}.mp4`);
      const poster = join(directory, `${randomUUID()}.jpg`);
      try {
        await writeFile(source, bytes);
        await runFfmpeg(source, poster, signal);
        return new Uint8Array(await readFile(poster));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
