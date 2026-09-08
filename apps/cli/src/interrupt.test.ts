import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERRUPT_NOTICE, installInterruptHandlers } from './interrupt.js';
import type { SignalTarget } from './interrupt.js';

function fakeTarget(): { target: SignalTarget; raise: (signal: 'SIGINT' | 'SIGTERM') => void; exit: ReturnType<typeof vi.fn> } {
  const handlers = new Map<string, () => void>();
  const exit = vi.fn();
  return {
    target: { on: (signal, handler) => handlers.set(signal, handler), exit },
    raise: (signal) => handlers.get(signal)!(),
    exit,
  };
}

describe('installInterruptHandlers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('aborts on the first %s and exits with %i on the second', (signal, code) => {
    const { target, raise, exit } = fakeTarget();
    const notify = vi.fn();
    const signalOut = installInterruptHandlers(target, notify);

    expect(signalOut.aborted).toBe(false);
    raise(signal);
    expect(signalOut.aborted).toBe(true);
    expect(notify).toHaveBeenCalledWith(INTERRUPT_NOTICE);
    expect(exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    raise(signal);
    expect(exit).toHaveBeenCalledWith(code);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('treats a SIGTERM after a SIGINT as the second interrupt', () => {
    const { target, raise, exit } = fakeTarget();
    installInterruptHandlers(target, vi.fn());
    raise('SIGINT');
    vi.advanceTimersByTime(500);
    raise('SIGTERM');
    expect(exit).toHaveBeenCalledWith(143);
  });

  it('ignores the echo when one interrupt is delivered twice at once', () => {
    // `timeout` and terminals that signal the process group as well as the process deliver the
    // same Ctrl-C twice; quitting on that would throw away the chapters the abort is saving.
    const { target, raise, exit } = fakeTarget();
    installInterruptHandlers(target, vi.fn());
    raise('SIGTERM');
    raise('SIGTERM');
    vi.advanceTimersByTime(100);
    raise('SIGTERM');
    expect(exit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    raise('SIGTERM');
    expect(exit).toHaveBeenCalledWith(143);
  });
});
