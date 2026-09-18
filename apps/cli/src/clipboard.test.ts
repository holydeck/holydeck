import { describe, expect, it } from 'vitest';
import { HolyDeckError } from '@holydeck/core/messages';
import {
  clipboardCommands,
  clipboardReadCommands,
  createClipboard,
  createClipboardReader,
  spawnCapture,
  spawnClipboard,
} from './clipboard.js';

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

describe('clipboardReadCommands', () => {
  it('uses pbpaste on darwin', () => {
    expect(clipboardReadCommands('darwin', {})).toEqual([{ command: 'pbpaste', args: [] }]);
  });

  it('reads through PowerShell on win32, where clip.exe has no read side', () => {
    expect(clipboardReadCommands('win32', {})).toEqual([
      { command: 'powershell', args: ['-NoProfile', '-Command', 'Get-Clipboard'] },
    ]);
  });

  it('uses xclip on X11 linux', () => {
    expect(clipboardReadCommands('linux', {})).toEqual([
      { command: 'xclip', args: ['-selection', 'clipboard', '-o'] },
    ]);
  });

  it('prefers wl-paste on wayland linux, with xclip fallback', () => {
    expect(clipboardReadCommands('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toEqual([
      { command: 'wl-paste', args: [] },
      { command: 'xclip', args: ['-selection', 'clipboard', '-o'] },
    ]);
  });
});

describe('createClipboardReader', () => {
  it('answers with what the first working tool printed', async () => {
    const calls: string[] = [];
    const read = createClipboardReader('darwin', {}, async (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      return { code: 0, text: 'Psalm 23:1' };
    });
    expect(await read()).toBe('Psalm 23:1');
    expect(calls).toEqual(['pbpaste ']);
  });

  it('falls back when a candidate cannot be spawned or exits nonzero', async () => {
    const calls: string[] = [];
    const read = createClipboardReader('linux', { WAYLAND_DISPLAY: 'wayland-0' }, async (command) => {
      calls.push(command);
      if (command === 'wl-paste') throw new Error('ENOENT');
      return { code: 0, text: 'from xclip' };
    });
    expect(await read()).toBe('from xclip');
    expect(calls).toEqual(['wl-paste', 'xclip']);
  });

  it('throws clipboard_read_unavailable naming every tried tool when all fail', async () => {
    const read = createClipboardReader('linux', { WAYLAND_DISPLAY: 'wayland-0' }, async (command) =>
      command === 'wl-paste' ? { code: 1, text: '' } : Promise.reject(new Error('ENOENT')),
    );
    const error = await read().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HolyDeckError);
    expect((error as HolyDeckError).code).toBe('clipboard_read_unavailable');
    expect((error as HolyDeckError).params['tried']).toBe('wl-paste, xclip');
  });
});

describe('spawnCapture (real child processes)', () => {
  it('answers with what the tool printed', async () => {
    await expect(spawnCapture('echo', ['hello'])).resolves.toEqual({ code: 0, text: 'hello\n' });
  });

  it('answers with the nonzero exit code of a tool that prints nothing', async () => {
    await expect(spawnCapture('false', [])).resolves.toEqual({ code: 1, text: '' });
  });

  it('rejects when the binary does not exist', async () => {
    await expect(spawnCapture('holydeck-no-such-binary-x9', [])).rejects.toThrow();
  });

  it('resolves 1 when the tool is killed by a signal (null exit code)', async () => {
    await expect(spawnCapture('sh', ['-c', 'kill -TERM $$'])).resolves.toEqual({ code: 1, text: '' });
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

  it('swallows the stdin EPIPE from a tool that stops reading a large write', async () => {
    // A payload well past any OS pipe buffer keeps the write in flight after the tool closes
    // its read end, so stdin emits an 'error' that the adapter must swallow (the exit code
    // decides instead). The tool lingers before exiting so the error always lands first —
    // exiting straight away races 'close', which would resolve before the handler ever runs.
    const big = 'x'.repeat(16 * 1024 * 1024);
    await expect(spawnClipboard('sh', ['-c', 'exec 0<&-; sleep 0.2; exit 1'], big)).resolves.toBe(1);
  });

  it('resolves 1 when the tool is killed by a signal (null exit code)', async () => {
    await expect(spawnClipboard('sh', ['-c', 'kill -TERM $$'], 'text')).resolves.toBe(1);
  });
});
