// Requests pass through this one boundary after `api.ts` has read their envelopes, so server facts that
// affect the whole application — an ended session or a retired client version — take effect consistently
// no matter which later screen made the request. Boot uses `ask` directly where onboarding must not
// redirect a still-unclaimed installation before it can show its first-run form.

import { ONBOARDING_PATH, parseOnboardingOffer } from '@holydeck/contracts/accounts';
import { NOT_FOUND } from '@holydeck/contracts/http';
import { SESSION_EXPIRED, SESSION_PATH, parseSessionView } from '@holydeck/contracts/sessions';

import { ask, askText, needsUpdate, type ApiResult, type Change, type FetchLike, type ResponseLike } from './api.js';
import { lastAnsweredAt, onboarding, session, updateRequired } from './app-state.js';
import { currentPath, navigate, route, safeNext, signInPathFor } from './router.js';

const defaultFetching: FetchLike = (url, init) =>
  globalThis.fetch(url, { ...init, credentials: 'same-origin' }) as Promise<ResponseLike>;

let fetching: FetchLike = defaultFetching;

/** Replaces the transport for this client, chiefly so a test or embedding host can supply its own boundary. */
export function setFetching(next: FetchLike): void {
  fetching = next;
}

/** The whole-application consequences of one answer, shared by every read and the upload. */
export function applied<T>(result: ApiResult<T>): ApiResult<T> {
  if (result.ok) lastAnsweredAt.value = Date.now();
  if (!result.ok && result.code === SESSION_EXPIRED) {
    session.value = null;
    if (route.value.name !== 'sign-in' && route.value.name !== 'welcome') {
      navigate(signInPathFor(currentPath.value), { replace: true });
    }
  }
  if (needsUpdate(result)) updateRequired.value = true;
  return result;
}

/**
 * Makes one parsed API request and applies the refusal states whose consequences belong to the whole
 * application. The result itself is not rewritten: a screen still receives its precise success or refusal.
 */
export async function request(path: string, change?: Change): Promise<ApiResult<unknown>> {
  return applied(await ask(path, fetching, change));
}

/** Reads raw text (a song's raw YAML) through the same transport, applying the same whole-app refusals. */
export async function requestText(path: string): Promise<ApiResult<string>> {
  return applied(await askText(path, fetching));
}

/**
 * Learns whether this installation is still waiting for its founder, then learns the browser session that
 * may already exist. Each answer is parsed before it reaches shared state, because malformed successful
 * JSON is no safer to render than a refused request.
 */
export async function boot(): Promise<void> {
  const offered = await ask(ONBOARDING_PATH, fetching);
  if (offered.ok) {
    const parsed = parseOnboardingOffer(offered.data);
    if (parsed.ok) {
      onboarding.value = parsed.value;
      session.value = null;
      if (route.value.name !== 'welcome') navigate('/welcome', { replace: true });
      return;
    }
  } else if (offered.code === NOT_FOUND) {
    onboarding.value = 'claimed';
  } else if (needsUpdate(offered)) {
    updateRequired.value = true;
  }

  const answered = await ask(SESSION_PATH, fetching);
  if (answered.ok) {
    const parsed = parseSessionView(answered.data);
    if (!parsed.ok) {
      session.value = null;
      return;
    }
    session.value = parsed.value;
    const matched = route.value;
    if (matched.name === 'root' || matched.name === 'sign-in' || matched.name === 'welcome') {
      const destination = matched.name === 'sign-in' ? safeNext(matched.next) ?? '/services' : '/services';
      navigate(destination, { replace: true });
    }
    return;
  }

  if (answered.code === SESSION_EXPIRED) {
    session.value = null;
    const matched = route.value;
    if (matched.name !== 'sign-in') {
      const path = currentPath.value === '/' || matched.name === 'welcome' ? '/' : currentPath.value;
      navigate(signInPathFor(path), { replace: true });
    }
    return;
  }

  if (needsUpdate(answered)) updateRequired.value = true;
  session.value = null;
}
