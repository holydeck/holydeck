import { errLine } from './context.js';
import type { CliContext } from './context.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_MS = 90;

export interface Spinner {
  /** Replaces the text shown next to the spinner, e.g. when a wait turns into a different wait. */
  label: (text: string) => void;
  stop: () => void;
}

/**
 * Shows that a silent step (starting the browser, waiting for a lock) is still working. Writes to
 * stderr so piped output stays clean, and degrades to one plain line when stderr is not a terminal.
 */
export function startSpinner(ctx: CliContext, text: string): Spinner {
  let label = text;
  let stopped = false;
  if (!ctx.isTTY) {
    // Without a cursor to rewrite there is nothing to animate, and echoing every label would
    // bury piped output; one line is enough to show the command started working.
    errLine(ctx, `${label}…`);
    return { label: () => {}, stop: () => {} };
  }
  let frame = 0;
  let width = 0;
  const render = (): void => {
    const line = `${FRAMES[frame % FRAMES.length]!} ${label}`;
    frame += 1;
    width = Math.max(width, line.length);
    ctx.err(`\r${line.padEnd(width)}`);
  };
  render();
  const timer = setInterval(render, FRAME_MS);
  timer.unref();
  ctx.status = (next) => {
    label = next;
  };
  return {
    label: (next) => {
      label = next;
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      ctx.status = undefined;
      ctx.err(`\r${' '.repeat(width)}\r`);
    },
  };
}
