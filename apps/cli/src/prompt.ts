import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** Only a plain yes is a yes. Everything else — a typo, a shrug, a closed pipe — leaves the file unwritten. */
const AFFIRMATIVE = /^(y|yes)$/iu;

/**
 * A yes/no question at the terminal. The streams are arguments rather than `process.stdin`/`stdout` so
 * a test can answer without a terminal, and so the question goes where the person is looking even when
 * stdout is being redirected into a file.
 */
export function createConfirm(input: Readable, output: Writable): (message: string) => Promise<boolean> {
  return (message) =>
    new Promise<boolean>((resolve) => {
      const rl = createInterface({ input, output });
      // A stream that ends before answering agreed to nothing, so it reads as a no.
      rl.on('close', () => resolve(false));
      rl.question(`${message} [y/N] `, (answer) => {
        // Answered before closed: closing emits 'close' at once, and a settled promise ignores it.
        resolve(AFFIRMATIVE.test(answer.trim()));
        rl.close();
      });
    });
}

/**
 * Whatever was piped into this run, or nothing at all when stdin is a terminal — checked first, because
 * reading a terminal's stdin would sit there waiting for someone to type the message by hand.
 */
export function createStdinReader(input: Readable & { isTTY?: boolean }): () => Promise<string | undefined> {
  return async () => {
    if (input.isTTY === true) return undefined;
    input.setEncoding('utf8');
    let text = '';
    for await (const chunk of input) text += String(chunk);
    return text;
  };
}
