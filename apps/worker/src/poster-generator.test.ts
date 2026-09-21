import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ffmpegPosterGenerator } from './poster-generator.js';

class FakeChild extends EventEmitter {
  readonly kill = vi.fn();
}

const spawned = vi.fn<(...args: unknown[]) => FakeChild>();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawned(...args) }));

const argOf = (index: number): string => {
  const value = (spawned.mock.calls[0]?.[1] as string[] | undefined)?.[index];
  if (value === undefined) throw new Error(`ffmpeg was not spawned with an argument at index ${index}`);
  return value;
};
const sourceOf = (): string => argOf(2);
const posterOf = (): string => argOf(5);

describe('the ffmpeg-backed poster generator', () => {
  it('shells out to ffmpeg and reads back the one frame it wrote', async () => {
    const child = new FakeChild();
    spawned.mockReturnValue(child);
    const generator = ffmpegPosterGenerator();

    const generating = generator.generate(new Uint8Array([1, 2, 3]), new AbortController().signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    await writeFile(posterOf(), new Uint8Array([9, 9, 9]));
    child.emit('close', 0);

    await expect(generating).resolves.toEqual(new Uint8Array([9, 9, 9]));
    expect(spawned).toHaveBeenCalledWith('ffmpeg', ['-y', '-i', sourceOf(), '-frames:v', '1', posterOf()], { stdio: 'ignore' });
    expect(existsSync(dirname(sourceOf()))).toBe(false);
  });

  it('rejects when ffmpeg exits with a failure code, and still cleans up its temp directory', async () => {
    const child = new FakeChild();
    spawned.mockReturnValue(child);
    const generator = ffmpegPosterGenerator();

    const generating = generator.generate(new Uint8Array([1, 2, 3]), new AbortController().signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    const directory = dirname(sourceOf());
    child.emit('close', 1);

    await expect(generating).rejects.toThrow('ffmpeg exited with code 1');
    expect(existsSync(directory)).toBe(false);
  });

  it('rejects when ffmpeg cannot be launched at all', async () => {
    const child = new FakeChild();
    spawned.mockReturnValue(child);
    const generator = ffmpegPosterGenerator();

    const generating = generator.generate(new Uint8Array([1, 2, 3]), new AbortController().signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    child.emit('error', new Error('ffmpeg is not installed'));

    await expect(generating).rejects.toThrow('ffmpeg is not installed');
  });

  it('kills the ffmpeg process when the lease is lost mid-frame', async () => {
    const child = new FakeChild();
    spawned.mockReturnValue(child);
    const generator = ffmpegPosterGenerator();
    const controller = new AbortController();

    const generating = generator.generate(new Uint8Array([1, 2, 3]), controller.signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    controller.abort();
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit('close', 137);

    await expect(generating).rejects.toThrow('ffmpeg exited with code 137');
  });

  it('kills the ffmpeg process on its own timeout, even when the caller signal never aborts', async () => {
    const child = new FakeChild();
    spawned.mockReturnValue(child);
    const generator = ffmpegPosterGenerator({ timeoutMs: 20 });
    const controller = new AbortController();

    const generating = generator.generate(new Uint8Array([1, 2, 3]), controller.signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledOnce());
    child.emit('close', 137);

    await expect(generating).rejects.toThrow('ffmpeg exited with code 137');
    expect(controller.signal.aborted).toBe(false);
  });
});
