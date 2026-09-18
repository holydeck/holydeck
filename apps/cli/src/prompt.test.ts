import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createConfirm, createStdinReader } from './prompt.js';

function asking(answer: string): { ask: (message: string) => Promise<boolean>; written: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on('data', (chunk: Buffer) => {
    chunks.push(chunk.toString());
  });
  input.end(answer);
  return { ask: createConfirm(input, output), written: () => chunks.join('') };
}

describe('createConfirm', () => {
  it.each([
    ['y', true],
    ['Y', true],
    ['yes', true],
    ['  YES  ', true],
    ['n', false],
    ['', false],
    ['nope', false],
    ['later', false],
  ])('reads %o as %s', async (answer, expected) => {
    expect(await asking(`${answer}\n`).ask('Write it?')).toBe(expected);
  });

  it('puts the question with the default spelled out', async () => {
    const asked = asking('y\n');
    await asked.ask('Write it?');
    expect(asked.written()).toContain('Write it? [y/N]');
  });

  it('takes a stream that closes without answering as a no', async () => {
    expect(await asking('').ask('Write it?')).toBe(false);
  });
});

describe('createStdinReader', () => {
  it('answers with nothing when stdin is a terminal, so no read ever blocks', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    expect(await createStdinReader(input)()).toBeUndefined();
  });

  it('joins everything piped in', async () => {
    const input = new PassThrough();
    input.write('Psalm 23:1\n');
    input.end('John 10:11\n');
    expect(await createStdinReader(input)()).toBe('Psalm 23:1\nJohn 10:11\n');
  });

  it('answers with the empty string when a pipe carries nothing', async () => {
    const input = new PassThrough();
    input.end('');
    expect(await createStdinReader(input)()).toBe('');
  });
});
