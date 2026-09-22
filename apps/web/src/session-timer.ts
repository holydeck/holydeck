// A server touch extends the session's idle window but never its absolute lifetime, so this module turns
// the last verified session answer into one warning and one signed-out transition. Keeping that clock
// outside components gives every route the same deadline and lets a mounting root stop it cleanly.

import { SESSION_IDLE_MINUTES, SESSION_PATH, sessionDeadlines, parseSessionView } from '@holydeck/contracts/sessions';
import { effect } from '@preact/signals';

import { expiryWarning, lastAnsweredAt, session } from './app-state.js';
import { t } from './i18n.js';
import { currentPath, navigate, route, signInPathFor } from './router.js';
import { request } from './request.js';
import { say } from './status.js';

import type { SessionView } from '@holydeck/contracts/sessions';

/** How long before a session's effective deadline the application gives its operator a chance to stay. */
export const WARN_BEFORE_MS = 5 * 60_000;

/** The later of the server-reported and locally-observed idle deadlines, capped by absolute expiry. */
export function idleDeadline(view: SessionView, lastAnswered: number | undefined): number {
  const serverIdle = Date.parse(sessionDeadlines(view).idle);
  const answeredIdle = (lastAnswered ?? 0) + SESSION_IDLE_MINUTES * 60_000;
  return Math.min(Date.parse(view.expiresAt), Math.max(serverIdle, answeredIdle));
}

/** Starts the shared session deadline clock and returns the stopper a mounting root owns. */
export function startSessionTimer(options: {
  readonly now?: () => number;
  readonly setTimer?: typeof setTimeout;
  readonly clearTimer?: typeof clearTimeout;
} = {}): () => void {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let warningTimer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = (): void => {
    if (warningTimer !== undefined) clearTimer(warningTimer);
    if (expiryTimer !== undefined) clearTimer(expiryTimer);
    warningTimer = undefined;
    expiryTimer = undefined;
  };

  const dispose = effect(() => {
    clearTimers();
    const view = session.value;
    const answered = lastAnsweredAt.value;
    if (view == null) {
      expiryWarning.value = undefined;
      return;
    }

    expiryWarning.value = undefined;
    const deadline = idleDeadline(view, answered);
    warningTimer = setTimer(() => {
      const minutes = Math.ceil((deadline - now()) / 60_000);
      expiryWarning.value = { minutes };
      say('assertive', t('session.expiring', { minutes }));
    }, Math.max(0, deadline - WARN_BEFORE_MS - now()));
    expiryTimer = setTimer(() => {
      session.value = null;
      expiryWarning.value = undefined;
      say('assertive', t('session.expired'));
      if (route.value.name !== 'sign-in' && route.value.name !== 'welcome') {
        navigate(signInPathFor(currentPath.value), { replace: true });
      }
    }, Math.max(0, deadline - now()));
  });

  return (): void => {
    clearTimers();
    dispose();
  };
}

/** Asks the session resource for a fresh touched record, replacing the warning only after it parses. */
export async function staySignedIn(): Promise<void> {
  const result = await request(SESSION_PATH);
  if (!result.ok) return;
  const parsed = parseSessionView(result.data);
  if (!parsed.ok) return;
  session.value = parsed.value;
  expiryWarning.value = undefined;
  say('polite', t('session.extended'));
}
