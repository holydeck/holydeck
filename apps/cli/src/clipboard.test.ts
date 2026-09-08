import { describe, expect, it } from 'vitest';
import { HolyDeckError } from '@holydeck/core/messages';
import { clipboardCommands, createClipboard, spawnClipboard } from './clipboard.js';

describe('clipboardCommands', () => {
  it('uses pbcopy on darwin', () => {
    expect(clipboardCommands('darwin', {})).toEqual([{ command: 'pbcopy', args: [] }]);
  });

  it('uses clip.exe on win32', () => {
    expect(clipboardCommands('win32', {})).toEqual([{ command: 'clip.exe', args: [] }]);
  });

  it('uses xclip on X11 linux', () => {
    expect(clipboardCommands('linux', {})).toEqual([
      { command: 'xclip', args: ['-selection', 'clipboard'] },
    ]);
  });

  it('prefers wl-copy on wayland linux, with xclip fallback', () => {
    expect(clipboardCommands('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toEqual([
      { command: 'wl-copy', args: [] },
      { command: 'xclip', args: ['-selection', 'clipboard'] },
    ]);
  });
});

describe('createClipboard', () => {
  it('resolves when the first candidate succeeds', async () => {
    const calls: string[] = [];
    const copy = createClipboard('darwin', {}, async (command, args, text) => {
      calls.push(`${command} ${args.join(' ')} <- ${text}`);
      return 0;
    });
    await copy('hello');
    expect(calls).toEqual(['pbcopy  <- hello']);
  });

  it('falls back when a candidate cannot be spawned or exits nonzero', async () => {
    const calls: string[] = [];
    const copy = createClipboard('linux', { WAYLAND_DISPLAY: 'wayland-0' }, async (command) => {
      calls.push(command);
      if (command === 'wl-copy') throw new Error('ENOENT');
      return 0;
    });
    await copy('hello');
    expect(calls).toEqual(['wl-copy', 'xclip']);
  });

  it('throws clipboard_unavailable naming every tried tool when all fail', async () => {
    const copy = createClipboard('linux', { WAYLAND_DISPLAY: 'wayland-0' }, async (command) =>
      command === 'wl-copy' ? 1 : Promise.reject(new Error('ENOENT')),
    );
    const error = await copy('hello').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HolyDeckError);
    expect((error as HolyDeckError).code).toBe('clipboard_unavailable');
    expect((error as HolyDeckError).params['tried']).toBe('wl-copy, xclip');
  });
});

describe('spawnClipboard (real child processes)', () => {
  it('resolves 0 for a tool that consumes stdin', async () => {
    await expect(spawnClipboard('cat', [], 'some text')).resolves.toBe(0);
  });

  it('resolves the nonzero exit code of a tool that ignores stdin', async () => {
    await expect(spawnClipboard('false', [], 'some text')).resolves.toBe(1);
  });

  it('rejects when the binary does not exist', async () => {
    await expect(spawnClipboard('holydeck-no-such-binary-x9', [], 'x')).rejects.toThrow();
  });

  it('swallows the stdin EPIPE from a tool that exits before reading a large write', async () => {
    // A payload well past any OS pipe buffer forces the write to still be in
    // flight when `false` exits and closes its read end, so stdin emits an
    // 'error' that the adapter must swallow (the exit code decides instead).
    const big = 'x'.repeat(16 * 1024 * 1024);
    await expect(spawnClipboard('false', [], big)).resolves.toBe(1);
  });

  it('resolves 1 when the tool is killed by a signal (null exit code)', async () => {
    await expect(spawnClipboard('sh', ['-c', 'kill -TERM $$'], 'text')).resolves.toBe(1);
  });
});
