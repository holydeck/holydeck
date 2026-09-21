import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { backupPath, checkRepository, forgetSnapshots, initRepository, restoreSnapshot } from './restic.js';

class FakeChild extends EventEmitter {
  readonly kill = vi.fn();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
}

const spawned = vi.fn<(...args: unknown[]) => FakeChild>();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawned(...args) }));

const OPTIONS = { repository: '/data/holydeck/restic', password: 'p'.repeat(64) };

/**
 * What every invocation is expected to be launched with. The password reaches restic through the child's
 * environment rather than its arguments: a command line is readable by every other process on the host,
 * and an environment is not.
 */
const LAUNCHED = {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: expect.objectContaining({ RESTIC_PASSWORD: OPTIONS.password }) as unknown,
};

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
      ['init', '--repo', OPTIONS.repository, '--json'],
      LAUNCHED,
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
      ['backup', '--repo', OPTIONS.repository, '--json', '--tag', 'media', '/data/holydeck/media'],
      LAUNCHED,
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

describe('restoring a snapshot with restic', () => {
  it('puts one snapshot back under a target of the caller’s choosing', async () => {
    const child = new FakeChild();
    spawned.mockReturnValue(child);

    const restoring = restoreSnapshot(OPTIONS, 'a1b2c3d4', '/tmp/rehearsal', new AbortController().signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    child.emit('close', 0);

    await expect(restoring).resolves.toBeUndefined();
    expect(spawned).toHaveBeenCalledWith(
      'restic',
      ['restore', 'a1b2c3d4', '--repo', OPTIONS.repository, '--json', '--target', '/tmp/rehearsal'],
      LAUNCHED,
    );
  });

  it('rejects when the snapshot cannot be restored', async () => {
    const child = new FakeChild();
    spawned.mockReturnValue(child);

    const restoring = restoreSnapshot(OPTIONS, 'missing', '/tmp/rehearsal', new AbortController().signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    child.stderr.emit('data', Buffer.from('Fatal: no matching ID found\n'));
    child.emit('close', 1);

    await expect(restoring).rejects.toThrow('no matching ID found');
  });
});

describe('checking the restic repository', () => {
  // The snapshot-addressed content classes carry `restic:<id>` rather than a digest, so there is nothing
  // in the manifest to rehash for them. What proves those is the repository's own check — and a structure
  // check alone never reads a byte of pack data, so a sample of it is read too.
  it('asks restic to verify its own structure and to read a sample of the data', async () => {
    const child = new FakeChild();
    spawned.mockReturnValue(child);

    const checking = checkRepository(OPTIONS, new AbortController().signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    child.emit('close', 0);

    await expect(checking).resolves.toBeUndefined();
    expect(spawned).toHaveBeenCalledWith(
      'restic',
      ['check', '--repo', OPTIONS.repository, '--read-data-subset=5%'],
      LAUNCHED,
    );
  });

  it('rejects a repository restic finds damaged', async () => {
    const child = new FakeChild();
    spawned.mockReturnValue(child);

    const checking = checkRepository(OPTIONS, new AbortController().signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    child.stderr.emit('data', Buffer.from('Fatal: repository contains errors\n'));
    child.emit('close', 1);

    await expect(checking).rejects.toThrow('repository contains errors');
  });
});

describe('forgetting snapshots retention no longer keeps', () => {
  it('forgets exactly the snapshots it was given, and prunes what only they held', async () => {
    const child = new FakeChild();
    spawned.mockReturnValue(child);

    const forgetting = forgetSnapshots(OPTIONS, ['aaa111', 'bbb222'], new AbortController().signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    child.emit('close', 0);

    await expect(forgetting).resolves.toBe(2);
    expect(spawned).toHaveBeenCalledWith(
      'restic',
      ['forget', '--repo', OPTIONS.repository, '--json', '--prune', 'aaa111', 'bbb222'],
      LAUNCHED,
    );
  });

  // Asking a tool to forget an empty list is a question with a different answer in every tool, and the
  // cost of finding out which kind restic is would be somebody's repository. Answered here instead.
  it('runs nothing at all when there is nothing to forget', async () => {
    spawned.mockClear();
    await expect(forgetSnapshots(OPTIONS, [], new AbortController().signal)).resolves.toBe(0);
    expect(spawned).not.toHaveBeenCalled();
  });

  it('rejects when restic refuses to forget them', async () => {
    const child = new FakeChild();
    spawned.mockReturnValue(child);

    const forgetting = forgetSnapshots(OPTIONS, ['aaa111'], new AbortController().signal);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    child.stderr.emit('data', Buffer.from('Fatal: no matching ID found\n'));
    child.emit('close', 1);

    await expect(forgetting).rejects.toThrow('no matching ID found');
  });
});

// A backup is a second copy of everything this deployment holds, sitting on a disk that leaves the
// building — and an unencrypted repository is that copy readable by whoever ends up with the disk. So
// the repository has a password, every command carries it, and there is no command here that can be
// talked into working without one.
describe('the repository password', () => {
  /** Every call this module can make, so a rule about all of them is asserted against all of them. */
  const invocations: ReadonlyArray<[string, (options: typeof OPTIONS) => Promise<unknown>]> = [
    ['init', (options) => initRepository(options, new AbortController().signal)],
    ['backup', (options) => backupPath(options, 'media', 'media', '/data/holydeck/media', new AbortController().signal)],
    ['restore', (options) => restoreSnapshot(options, 'a1b2c3d4', '/tmp/rehearsal', new AbortController().signal)],
    ['check', (options) => checkRepository(options, new AbortController().signal)],
    ['forget', (options) => forgetSnapshots(options, ['aaa111'], new AbortController().signal)],
  ];

  it.each(invocations)('never asks restic to skip encryption on %s', async (_name, invoke) => {
    const child = new FakeChild();
    spawned.mockClear();
    spawned.mockReturnValue(child);

    const running = invoke(OPTIONS);
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    child.stdout.emit('data', Buffer.from(summaryLine({ snapshot_id: 'a1b2c3d4' })));
    child.emit('close', 0);
    await running.catch(() => undefined);

    const args = spawned.mock.calls[0]?.[1] as readonly string[];
    expect(args).not.toContain('--insecure-no-password');
    // And the password is not smuggled into the argument list either: `ps` on the host reads that.
    expect(args).not.toContain(OPTIONS.password);
    expect(args.join(' ')).not.toContain(OPTIONS.password);
  });

  it.each(invocations)('refuses to touch the repository at all with no password to open it: %s', async (_name, invoke) => {
    spawned.mockClear();

    await expect(invoke({ ...OPTIONS, password: '' })).rejects.toThrow('no repository password');

    // Refused here rather than by restic, which with nothing on stdin fails on a prompt nobody can answer
    // — a message about a terminal, for what is really a deployment that never had its secret written.
    expect(spawned).not.toHaveBeenCalled();
  });
});
