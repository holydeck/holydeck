import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANTHROPIC_MESSAGES_URL, RESOLVE_TOOL_NAME } from '@holydeck/core/anthropic';
import { makeContext } from '../../test/harness.js';
import { runCli } from '../program.js';
import { readState } from '../state.js';

/** Obviously not a key. Nothing in this repo may carry a string that could pass for a real one. */
const API_KEY = 'test-api-key';

/** Every book name in it places deterministically, so nothing here ever reaches the network. */
const CLEAN = ['Sermon: The Good Shepherd', 'Psalm 23:1-3', 'John 10:11'].join('\n');

/** "Roman" is not a book this build knows, so it is exactly what the optional resolver is asked about. */
const WITH_UNKNOWN = ['Sermon: Broken Yoke', 'Roman 7:15', 'John 10:11'].join('\n');

/** FIXED_NOW is a Tuesday, so the sermon is for the Sunday after it. */
const CLEAN_FILE = '2026-09-13-the-good-shepherd.yml';
const UNKNOWN_FILE = '2026-09-13-broken-yoke.yml';

const RESOLVED_ROMANS = {
  [`POST ${ANTHROPIC_MESSAGES_URL}`]: {
    status: 200,
    body: JSON.stringify({
      content: [{ type: 'tool_use', name: RESOLVE_TOOL_NAME, input: { resolutions: [{ token: 'Roman', usfm: 'ROM' }] } }],
      usage: { input_tokens: 412, output_tokens: 27 },
    }),
  },
};

describe('ai', () => {
  it('writes the file the message describes and says where it went', async () => {
    const setup = makeContext({ clipboardText: CLEAN });
    await expect(runCli(setup.ctx, ['ai', '--yes'])).resolves.toBe(0);

    const path = join(setup.home, CLEAN_FILE);
    expect(setup.stdout()).toBe(`${path}\n`);
    const written = readFileSync(path, 'utf8');
    // Nothing is configured here, so the file gets the same fallback translation `new` scaffolds.
    expect(written).toContain('translations:\n  - KJV');
    expect(written).toContain('book: PSA');
    expect(written).toContain('book: JHN');
    expect(await readState(setup.dataDir)).toEqual({ lastSermonFile: path });
  });

  it('shows the file it would write before writing it', async () => {
    const setup = makeContext({ clipboardText: CLEAN });
    await expect(runCli(setup.ctx, ['ai', '--yes'])).resolves.toBe(0);

    expect(setup.stderr()).toContain(CLEAN_FILE);
    expect(setup.stderr()).toContain('book: PSA');
  });

  it('prefers what was piped in over the clipboard', async () => {
    const setup = makeContext({ stdinText: CLEAN });
    await expect(runCli(setup.ctx, ['ai', '--yes'])).resolves.toBe(0);

    expect(setup.clipboardReads()).toBe(0);
    expect(existsSync(join(setup.home, CLEAN_FILE))).toBe(true);
  });

  it('reads the clipboard when the pipe carried nothing worth reading', async () => {
    const setup = makeContext({ stdinText: '   \n', clipboardText: CLEAN });
    await expect(runCli(setup.ctx, ['ai', '--yes'])).resolves.toBe(0);

    expect(setup.clipboardReads()).toBe(1);
    expect(existsSync(join(setup.home, CLEAN_FILE))).toBe(true);
  });

  it('takes the clipboard over the pipe when --clipboard says so', async () => {
    const setup = makeContext({ stdinText: WITH_UNKNOWN, clipboardText: CLEAN });
    await expect(runCli(setup.ctx, ['ai', '--clipboard', '--yes'])).resolves.toBe(0);

    expect(existsSync(join(setup.home, CLEAN_FILE))).toBe(true);
  });

  it('prefers what was piped in over --editor when both are available', async () => {
    const setup = makeContext({
      stdinText: WITH_UNKNOWN,
      overrides: {
        editor: async () => {
          throw new Error('the editor should not open when a pipe already carried the message');
        },
      },
    });
    await expect(runCli(setup.ctx, ['ai', '--editor', '--yes'])).resolves.toBe(0);

    expect(existsSync(join(setup.home, UNKNOWN_FILE))).toBe(true);
  });

  it('composes the message in $EDITOR when --editor is passed and nothing was piped in, and uses what was saved', async () => {
    const setup = makeContext({
      clipboardText: WITH_UNKNOWN,
      overrides: {
        editor: async (path) => {
          await writeFile(path, CLEAN, 'utf8');
          return 'opened';
        },
      },
    });
    await expect(runCli(setup.ctx, ['ai', '--editor', '--yes'])).resolves.toBe(0);

    expect(setup.clipboardReads()).toBe(0);
    expect(existsSync(join(setup.home, CLEAN_FILE))).toBe(true);
  });

  it('reads back an empty buffer when nothing was typed and saved in $EDITOR', async () => {
    const setup = makeContext({});
    await expect(runCli(setup.ctx, ['ai', '--editor', '--yes'])).resolves.toBe(1);

    expect(setup.edits).toHaveLength(1);
    expect(setup.stderr()).toContain('no line in it reads as');
  });

  it('warns when $EDITOR is not set, and still proceeds with whatever the blank buffer holds', async () => {
    const setup = makeContext({ overrides: { editor: async () => 'skipped' } });
    await expect(runCli(setup.ctx, ['ai', '--editor', '--yes'])).resolves.toBe(1);

    expect(setup.stderr()).toContain('$EDITOR is not set');
  });

  it.each([
    ['the pipe carried nothing', ''],
    ['stdin is a terminal nobody piped into', undefined],
  ])('never reaches for the clipboard when --stdin says where to read, even when %s', async (_case, stdinText) => {
    const setup = makeContext({ stdinText, clipboardText: CLEAN });
    await expect(runCli(setup.ctx, ['ai', '--stdin', '--yes'])).resolves.toBe(1);

    expect(setup.clipboardReads()).toBe(0);
    expect(setup.stderr()).toContain('no line in it reads as');
  });

  it('renders the translations the configuration names', async () => {
    const setup = makeContext({ clipboardText: CLEAN, env: { HOLYDECK_TRANSLATIONS: 'KJV,SCH2000' } });
    await expect(runCli(setup.ctx, ['ai', '--yes'])).resolves.toBe(0);

    expect(readFileSync(join(setup.home, CLEAN_FILE), 'utf8')).toContain('translations:\n  - KJV\n  - SCH2000');
  });

  it('refuses to overwrite a file that is already there, before asking anything', async () => {
    const setup = makeContext({ clipboardText: CLEAN, overrides: { isTTY: true } });
    const path = join(setup.home, CLEAN_FILE);
    writeFileSync(path, 'mine\n', 'utf8');

    await expect(runCli(setup.ctx, ['ai'])).resolves.toBe(1);
    expect(readFileSync(path, 'utf8')).toBe('mine\n');
    expect(setup.confirmations).toEqual([]);
  });

  it('asks before writing when there is a terminal to ask at', async () => {
    const setup = makeContext({ clipboardText: CLEAN, overrides: { isTTY: true } });
    await expect(runCli(setup.ctx, ['ai'])).resolves.toBe(0);

    expect(setup.confirmations).toHaveLength(1);
    expect(setup.confirmations[0]).toContain(CLEAN_FILE);
    expect(existsSync(join(setup.home, CLEAN_FILE))).toBe(true);
  });

  it('writes nothing when the confirmation is declined', async () => {
    const setup = makeContext({ clipboardText: CLEAN, confirmAnswer: false, overrides: { isTTY: true } });
    await expect(runCli(setup.ctx, ['ai'])).resolves.toBe(0);

    expect(existsSync(join(setup.home, CLEAN_FILE))).toBe(false);
    expect(setup.stderr()).toContain('Nothing was written.');
    expect(setup.stdout()).toBe('');
    expect(await readState(setup.dataDir)).toEqual({});
  });

  it('refuses to write unasked when there is no terminal to ask at', async () => {
    const setup = makeContext({ clipboardText: CLEAN });
    await expect(runCli(setup.ctx, ['ai'])).resolves.toBe(1);

    expect(existsSync(join(setup.home, CLEAN_FILE))).toBe(false);
    expect(setup.stderr()).toContain('--yes');
    expect(setup.confirmations).toEqual([]);
  });

  it('carries every notice out to stderr and still writes what it could place', async () => {
    const setup = makeContext({ clipboardText: WITH_UNKNOWN });
    await expect(runCli(setup.ctx, ['ai', '--yes'])).resolves.toBe(0);

    const stderr = setup.stderr();
    expect(stderr).toContain('ANTHROPIC_API_KEY');
    expect(stderr).toContain('Roman 7:15');
    expect(readFileSync(join(setup.home, UNKNOWN_FILE), 'utf8')).toContain('book: JHN');
  });

  it('makes no outbound call at all when no key is configured', async () => {
    const setup = makeContext({ clipboardText: WITH_UNKNOWN });
    await expect(runCli(setup.ctx, ['ai', '--yes'])).resolves.toBe(0);

    expect(setup.requests).toEqual([]);
  });

  it('asks the resolver about a leftover book name when a key is configured', async () => {
    const setup = makeContext({
      clipboardText: WITH_UNKNOWN,
      env: { ANTHROPIC_API_KEY: API_KEY },
      responses: RESOLVED_ROMANS,
    });
    await expect(runCli(setup.ctx, ['ai', '--yes'])).resolves.toBe(0);

    expect(setup.requests).toHaveLength(1);
    expect(readFileSync(join(setup.home, UNKNOWN_FILE), 'utf8')).toContain('book: ROM');
  });

  it('reports the call it made without repeating a word of what it sent', async () => {
    const setup = makeContext({
      clipboardText: WITH_UNKNOWN,
      env: { ANTHROPIC_API_KEY: API_KEY },
      responses: RESOLVED_ROMANS,
    });
    await expect(runCli(setup.ctx, ['ai', '--yes'])).resolves.toBe(0);

    const output = setup.stdout() + setup.stderr();
    expect(output).toMatch(/Anthropic book-name resolver: allowed in \d+ms \(412 in, 27 out\)\./u);
    expect(output).not.toContain(API_KEY);
    expect(output).not.toContain('Roman');
  });

  it('reports a refused call and still writes the passages it placed on its own', async () => {
    const setup = makeContext({
      clipboardText: WITH_UNKNOWN,
      env: { ANTHROPIC_API_KEY: API_KEY },
      responses: { [`POST ${ANTHROPIC_MESSAGES_URL}`]: { status: 503, body: 'down' } },
    });
    await expect(runCli(setup.ctx, ['ai', '--yes'])).resolves.toBe(0);

    const stderr = setup.stderr();
    expect(stderr).toMatch(/Anthropic book-name resolver: refused in \d+ms\./u);
    expect(stderr).toContain('Could not reach the book-name resolver');
    expect(stderr).not.toContain(API_KEY);
    expect(readFileSync(join(setup.home, UNKNOWN_FILE), 'utf8')).toContain('book: JHN');
  });

  it('refuses a message with no passage in it at all', async () => {
    const setup = makeContext({ clipboardText: 'Good morning everyone!' });
    await expect(runCli(setup.ctx, ['ai', '--yes'])).resolves.toBe(1);

    expect(setup.stderr()).toContain('no line in it reads as');
    expect(setup.stdout()).toBe('');
  });
});
