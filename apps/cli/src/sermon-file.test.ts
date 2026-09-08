import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeContext } from '../test/harness.js';
import { readSermonFile } from './sermon-file.js';

// The operating system denies a real cloud-drive file, which no fixture can reproduce, so the
// denial is injected: everything else in this file still reads the disk for real.
const denied = vi.hoisted(() => ({ code: undefined as string | undefined }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (denied.code === undefined) return actual.readFile(...args);
      const error: NodeJS.ErrnoException = new Error(`${denied.code}: operation not permitted, open '${String(args[0])}'`);
      error.code = denied.code;
      return Promise.reject(error);
    },
  };
});

describe('readSermonFile', () => {
  afterEach(() => {
    denied.code = undefined;
  });

  it('reads a relative path against the working directory and returns the absolute one', async () => {
    const { ctx } = makeContext();
    writeFileSync(join(ctx.cwd, 'sermon.yml'), 'translations:\n  - KJV\n', 'utf8');
    await expect(readSermonFile(ctx, 'sermon.yml')).resolves.toEqual({
      path: join(ctx.cwd, 'sermon.yml'),
      text: 'translations:\n  - KJV\n',
    });
  });

  it('reports a genuinely absent file as missing', async () => {
    const { ctx } = makeContext();
    await expect(readSermonFile(ctx, 'nope.yml')).rejects.toMatchObject({
      code: 'sermon_file_missing',
      params: { path: join(ctx.cwd, 'nope.yml') },
    });
  });

  it.each(['EPERM', 'EACCES'])('points at the permissions when access is denied (%s)', async (code) => {
    const { ctx } = makeContext();
    writeFileSync(join(ctx.cwd, 'sermon.yml'), 'translations:\n  - KJV\n', 'utf8');
    denied.code = code;
    const error = await readSermonFile(ctx, 'sermon.yml').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'sermon_file_forbidden' });
    expect((error as Error).message).toContain('Check the permissions');
  });

  it('names Full Disk Access when the denied file sits in a cloud drive', async () => {
    const { ctx } = makeContext();
    denied.code = 'EPERM';
    const cloudPath = '/Users/someone/Library/CloudStorage/GoogleDrive-someone/Sermons/2026-09-06.yml';
    const error = await readSermonFile(ctx, cloudPath).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'sermon_file_forbidden_cloud', params: { path: cloudPath } });
    expect((error as Error).message).toContain('Full Disk Access');
  });

  it('reports the real reason when the path exists but cannot be read', async () => {
    const { ctx } = makeContext();
    mkdirSync(join(ctx.cwd, 'sermons'));
    const error = await readSermonFile(ctx, 'sermons').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'sermon_file_unreadable' });
    expect((error as Error).message).toContain('EISDIR');
  });
});
