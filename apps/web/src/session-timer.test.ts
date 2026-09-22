// @vitest-environment happy-dom
// Session timers derive their deadline from both the server record and locally answered activity, so
// these clock-driven tests use one frozen browser time and always stop the effect that owns its timers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { successEnvelope } from '@holydeck/contracts/http';
import { SESSION_IDLE_MINUTES } from '@holydeck/contracts/sessions';

import { expiryWarning, lastAnsweredAt, resetAppState, session } from './app-state.js';
import { setFetching } from './request.js';
import { currentPath } from './router.js';
import { idleDeadline, startSessionTimer, staySignedIn, WARN_BEFORE_MS } from './session-timer.js';

import type { SessionView } from '@holydeck/contracts/sessions';

const START = new Date('2026-09-13T10:00:00.000Z');
const VIEW: SessionView = {
  actor: 'account:GLkQ5wEtQEy5PfN2Zr9m7A',
  permissions: ['services.read'],
  startedAt: START.toISOString(),
  lastSeenAt: START.toISOString(),
  expiresAt: '2026-09-14T10:00:00.000Z',
  rotation: 'authentication',
  csrf: 'a'.repeat(43),
  slots: [],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  resetAppState();
  currentPath.value = '/services/example';
  document.body.innerHTML = '<p id="announce-polite"></p><p id="announce-assertive"></p>';
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('the session timer', () => {
  it('warns five minutes before the idle deadline, and not before', () => {
    session.value = VIEW;
    const stop = startSessionTimer();

    vi.advanceTimersByTime(SESSION_IDLE_MINUTES * 60_000 - WARN_BEFORE_MS - 1);
    expect(expiryWarning.value).toBeUndefined();
    vi.advanceTimersByTime(1);

    expect(expiryWarning.value).toEqual({ minutes: 5 });
    expect(document.getElementById('announce-assertive')?.textContent).toContain('5 minutes');
    stop();
  });

  it('moves a scheduled deadline forward when a request was answered after its warning', () => {
    session.value = VIEW;
    const stop = startSessionTimer();
    vi.advanceTimersByTime(SESSION_IDLE_MINUTES * 60_000 - WARN_BEFORE_MS);
    expect(expiryWarning.value).toEqual({ minutes: 5 });

    lastAnsweredAt.value = Date.now();
    expect(expiryWarning.value).toBeUndefined();
    vi.advanceTimersByTime(WARN_BEFORE_MS);
    expect(session.value).toEqual(VIEW);
    vi.advanceTimersByTime(SESSION_IDLE_MINUTES * 60_000 - 2 * WARN_BEFORE_MS);

    expect(expiryWarning.value).toEqual({ minutes: 5 });
    stop();
  });

  it('ends an expired session and returns its protected path to sign-in', () => {
    session.value = VIEW;
    const stop = startSessionTimer();

    vi.advanceTimersByTime(SESSION_IDLE_MINUTES * 60_000);

    expect(session.value).toBeNull();
    expect(expiryWarning.value).toBeUndefined();
    expect(currentPath.value).toBe('/sign-in?next=%2Fservices%2Fexample');
    expect(document.getElementById('announce-assertive')?.textContent).toBe('You were signed out after a period of inactivity.');
    stop();
  });

  it('replaces the session and clears the warning when the operator stays signed in', async () => {
    session.value = VIEW;
    expiryWarning.value = { minutes: 5 };
    const replacement = { ...VIEW, lastSeenAt: '2026-09-13T11:55:00.000Z' };
    setFetching(async () => ({ status: 200, json: async (): Promise<unknown> => successEnvelope(replacement, 'request-1') }));

    await staySignedIn();

    expect(session.value).toEqual(replacement);
    expect(expiryWarning.value).toBeUndefined();
    expect(document.getElementById('announce-polite')?.textContent).toBe('You are still signed in.');
  });

  it('caps locally observed activity at the absolute deadline', () => {
    const capped = { ...VIEW, expiresAt: '2026-09-13T10:30:00.000Z' };
    const answered = Date.parse('2026-09-13T10:20:00.000Z');

    expect(idleDeadline(capped, answered)).toBe(Date.parse(capped.expiresAt));
  });

  it('cancels both pending timers when its mounting root stops it', () => {
    session.value = VIEW;
    const stop = startSessionTimer();
    stop();

    vi.advanceTimersByTime(SESSION_IDLE_MINUTES * 60_000);

    expect(expiryWarning.value).toBeUndefined();
    expect(session.value).toEqual(VIEW);
  });
});
