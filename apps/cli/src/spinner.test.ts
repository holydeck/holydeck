import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeContext } from '../test/harness.js';
import { startSpinner } from './spinner.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('startSpinner on a terminal', () => {
  it('animates, retitles in place and clears the line when stopped', () => {
    vi.useFakeTimers();
    const setup = makeContext({ overrides: { isTTY: true } });
    const spinner = startSpinner(setup.ctx, 'KJV: preparing');
    expect(setup.stderr()).toContain('⠋ KJV: preparing');

    vi.advanceTimersByTime(200);
    expect(setup.stderr()).toContain('⠙ KJV: preparing');

    spinner.label('KJV: waiting for the lock');
    vi.advanceTimersByTime(100);
    expect(setup.stderr()).toContain('KJV: waiting for the lock');

    spinner.stop();
    expect(setup.stderr().endsWith('\r')).toBe(true);
    expect(setup.ctx.status).toBeUndefined();
  });

  it('publishes a status hook that background waits can retitle it with', () => {
    vi.useFakeTimers();
    const setup = makeContext({ overrides: { isTTY: true } });
    const spinner = startSpinner(setup.ctx, 'KJV: preparing');
    setup.ctx.status?.('KJV: datastore locked');
    vi.advanceTimersByTime(100);
    expect(setup.stderr()).toContain('KJV: datastore locked');
    spinner.stop();
  });

  it('stops only once, leaving later output alone', () => {
    vi.useFakeTimers();
    const setup = makeContext({ overrides: { isTTY: true } });
    const spinner = startSpinner(setup.ctx, 'KJV: preparing');
    spinner.stop();
    const afterFirstStop = setup.stderr();
    spinner.stop();
    vi.advanceTimersByTime(500);
    expect(setup.stderr()).toBe(afterFirstStop);
  });
});

describe('startSpinner without a terminal', () => {
  it('prints one plain line and never animates or echoes later labels', () => {
    vi.useFakeTimers();
    const setup = makeContext();
    const spinner = startSpinner(setup.ctx, 'KJV: preparing');
    vi.advanceTimersByTime(500);
    spinner.label('KJV: waiting for the lock');
    spinner.stop();
    expect(setup.stderr()).toBe('KJV: preparing…\n');
    // no status hook, so a lock wait falls back to a plain line of its own
    expect(setup.ctx.status).toBeUndefined();
  });
});
