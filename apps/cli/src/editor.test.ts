import { describe, expect, it } from 'vitest';
import { HolyDeckError } from '@holydeck/core/messages';
import { createEditor, spawnEditor } from './editor.js';

describe('createEditor', () => {
  it('skips when $EDITOR is unset', async () => {
    const open = createEditor({}, async () => 0);
    await expect(open('/tmp/x.yml')).resolves.toBe('skipped');
  });

  it('splits $EDITOR into command and args and appends the path', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const open = createEditor({ EDITOR: 'code --wait' }, async (command, args) => {
      calls.push({ command, args });
      return 0;
    });
    await expect(open('/tmp/x.yml')).resolves.toBe('opened');
    expect(calls).toEqual([{ command: 'code', args: ['--wait', '/tmp/x.yml'] }]);
  });

  it('throws editor_failed on a nonzero exit', async () => {
    const open = createEditor({ EDITOR: 'vim' }, async () => 3);
    const error = await open('/tmp/x.yml').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HolyDeckError);
    expect((error as HolyDeckError).code).toBe('editor_failed');
    expect((error as HolyDeckError).params).toEqual({ editor: 'vim', status: 3 });
  });

  it('throws editor_failed when the editor cannot be spawned', async () => {
    const open = createEditor({ EDITOR: 'no-such-editor' }, async () => {
      throw new Error('ENOENT');
    });
    const error = await open('/tmp/x.yml').catch((e: unknown) => e);
    expect((error as HolyDeckError).code).toBe('editor_failed');
    expect((error as HolyDeckError).params).toEqual({ editor: 'no-such-editor', status: 'spawn failed' });
  });
});

describe('spawnEditor (real child processes)', () => {
  it('resolves the exit code', async () => {
    await expect(spawnEditor('true', [])).resolves.toBe(0);
    await expect(spawnEditor('false', [])).resolves.toBe(1);
  });

  it('rejects when the binary does not exist', async () => {
    await expect(spawnEditor('holydeck-no-such-binary-x9', [])).rejects.toThrow();
  });

  it('resolves 1 when the tool is killed by a signal (null exit code)', async () => {
    await expect(spawnEditor('sh', ['-c', 'kill -TERM $$'])).resolves.toBe(1);
  });
});
