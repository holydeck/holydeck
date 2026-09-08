export interface SignalTarget {
  on: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void;
  exit: (code: number) => void;
}

export const INTERRUPT_NOTICE =
  'interrupted — saving what was fetched and releasing the datastore lock; press Ctrl-C again to quit now';

/**
 * One interrupt can reach us twice — a process group gets signalled alongside the process itself,
 * and `timeout` does exactly that. Ignoring the echo keeps a single Ctrl-C on the graceful path.
 */
const QUIT_GRACE_MS = 250;

/**
 * Node's default signal handling terminates the process outright, which skips the cleanup that
 * releases the datastore lock and saves fetched chapters. Handling the first interrupt ourselves
 * turns it into a graceful stop; a second one means the user wants out regardless.
 */
export function installInterruptHandlers(target: SignalTarget, notify: (line: string) => void): AbortSignal {
  const controller = new AbortController();
  let abortedAt = 0;
  const handle = (code: number) => (): void => {
    if (controller.signal.aborted) {
      if (Date.now() - abortedAt >= QUIT_GRACE_MS) target.exit(code);
      return;
    }
    abortedAt = Date.now();
    controller.abort();
    notify(INTERRUPT_NOTICE);
  };
  target.on('SIGINT', handle(130));
  target.on('SIGTERM', handle(143));
  return controller.signal;
}
