import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { backupPath, initRepository } from './restic.js';

class FakeChild extends EventEmitter {
  readonly kill = vi.fn();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

const spawned = vi.fn<(...args: unknown[]) => FakeChild>();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawned(...args) }));

const OPTIONS = { repository: '/data/holydeck/restic' };

const summaryLine = (fields: Record<string, unknown>): string =>
  `${JSON.stringify({ message_type: 'summary', ...fields })}\n`;

describe('initializing the restic repository', () => {
  it('shells out to restic init', async () => {
    const child = new FakeChild();
    spawned.mockReturnValue(child);

    const initializing = initRepository(OPTIONS, new AbortController().signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    child.emit('close', 0);

    await expect(initializing).resolves.toBeUndefined();
    expect(spawned).toHaveBeenCalledWith(
      'restic',
      ['init', '--repo', OPTIONS.repository, '--insecure-no-password', '--json'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  });

  it('treats a repository already initialized as success', async () => {
    const child = new FakeChild();
    spawned.mockReturnValue(child);

    const initializing = initRepository(OPTIONS, new AbortController().signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    child.stderr.emit('data', Buffer.from('Fatal: repository master key and config already initialized\n'));
    child.emit('close', 1);

    await expect(initializing).resolves.toBeUndefined();
  });

  it('rejects a failure that is not the already-initialized case', async () => {
    const child = new FakeChild();
    spawned.mockReturnValue(child);

    const initializing = initRepository(OPTIONS, new AbortController().signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    child.stderr.emit('data', Buffer.from('Fatal: unable to open repository\n'));
    child.emit('close', 1);

    await expect(initializing).rejects.toThrow('unable to open repository');
  });

  it('rejects when restic cannot be launched at all', async () => {
    const child = new FakeChild();
    spawned.mockReturnValue(child);

    const initializing = initRepository(OPTIONS, new AbortController().signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    child.emit('error', new Error('restic is not installed'));

    await expect(initializing).rejects.toThrow('restic is not installed');
  });
});

describe('backing up a path with restic', () => {
  it('parses the NDJSON summary line into a backup content entry', async () => {
    const child = new FakeChild();
    spawned.mockReturnValue(child);

    const backing = backupPath(OPTIONS, 'media', 'media', '/data/holydeck/media', new AbortController().signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ message_type: 'status', percent_done: 0.5 })}\n`));
    child.stdout.emit(
      'data',
      Buffer.from(
        summaryLine({
          files_new: 2,
          files_changed: 1,
          files_unmodified: 3,
          total_bytes_processed: 4096,
          snapshot_id: 'a1b2c3d4',
        }),
      ),
    );
    child.emit('close', 0);

    await expect(backing).resolves.toEqual({ class: 'media', count: 6, bytes: 4096, hash: 'restic:a1b2c3d4' });
    expect(spawned).toHaveBeenCalledWith(
      'restic',
      ['backup', '--repo', OPTIONS.repository, '--insecure-no-password', '--json', '--tag', 'media', '/data/holydeck/media'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  });

  it('rejects when restic exits without ever emitting a summary line', async () => {
    const child = new FakeChild();
    spawned.mockReturnValue(child);

    const backing = backupPath(OPTIONS, 'media', 'media', '/data/holydeck/media', new AbortController().signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ message_type: 'status', percent_done: 1 })}\n`));
    child.emit('close', 0);

    await expect(backing).rejects.toThrow('produced no summary line');
  });

  it('rejects a summary line naming no snapshot', async () => {
    const child = new FakeChild();
    spawned.mockReturnValue(child);

    const backing = backupPath(OPTIONS, 'media', 'media', '/data/holydeck/media', new AbortController().signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from(summaryLine({ files_new: 1 })));
    child.emit('close', 0);

    await expect(backing).rejects.toThrow('named no snapshot');
  });

  it('rejects when restic exits with a failure code', async () => {
    const child = new FakeChild();
    spawned.mockReturnValue(child);

    const backing = backupPath(OPTIONS, 'media', 'media', '/data/holydeck/media', new AbortController().signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    child.stderr.emit('data', Buffer.from('Fatal: unable to read source\n'));
    child.emit('close', 1);

    await expect(backing).rejects.toThrow('unable to read source');
  });

  it('kills the restic process when the lease is lost mid-backup', async () => {
    const child = new FakeChild();
    spawned.mockReturnValue(child);
    const controller = new AbortController();

    const backing = backupPath(OPTIONS, 'media', 'media', '/data/holydeck/media', controller.signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    controller.abort();
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit('close', 130);

    await expect(backing).rejects.toThrow('restic exited with code 130');
  });
});
