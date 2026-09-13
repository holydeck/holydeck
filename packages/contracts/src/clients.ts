// The client compatibility window. A server accepts the current client version and the one before it;
// anything else is told to update, with the stable code and the words the contract names. A first
// release has one version inside its window and no previous one, which is why `previous` is optional
// rather than a sentinel number: a sentinel would have to be either inside the window or outside it,
// and both readings are wrong for a version that was never released.

import { UPDATE_REQUIRED } from './http.js';
import { isRecord } from './problems.js';

export type ClientWindow = { readonly current: number; readonly previous?: number };

export const CLIENT_WINDOW: ClientWindow = { current: 1 };

export const CLIENT_VERSION_HEADER = 'x-holydeck-client-version';

export const UPDATE_REQUIRED_MESSAGE = 'Update required';

// The released status for this code. It is written out rather than looked up in the registry so a
// refusal cannot fall back to a guessed status when the lookup finds nothing; `clients.test.ts`
// holds it against `statusForCode(UPDATE_REQUIRED)` so the two cannot drift apart.
export const UPDATE_REQUIRED_STATUS = 426;

export type ClientDecision =
  | { readonly accepted: true; readonly version: number }
  | {
      readonly accepted: false;
      readonly code: typeof UPDATE_REQUIRED;
      readonly status: number;
      readonly message: string;
      readonly supported: readonly number[];
    };

export function supportedClientVersions(window: ClientWindow = CLIENT_WINDOW): readonly number[] {
  return window.previous === undefined ? [window.current] : [window.previous, window.current];
}

const asVersion = (value: unknown): number | undefined => {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) ? number : undefined;
};

/**
 * Decides about one client. A version this build cannot read at all — absent, misspelled, or newer
 * than the server — is refused the same way an older one is: the server has no protocol to serve it
 * with, and guessing on the client's behalf is how a stale command reaches a live service.
 */
export function decideClient(version: unknown, window: ClientWindow = CLIENT_WINDOW): ClientDecision {
  const supported = supportedClientVersions(window);
  const claimed = asVersion(version);
  if (claimed !== undefined && supported.includes(claimed)) return { accepted: true, version: claimed };
  return {
    accepted: false,
    code: UPDATE_REQUIRED,
    status: UPDATE_REQUIRED_STATUS,
    message: UPDATE_REQUIRED_MESSAGE,
    supported,
  };
}

/**
 * Grades a compatibility recording — the window, the outcome each client version received, and the
 * released interfaces that must survive the window moving — in the words the criterion uses.
 */
export function clientCompatibilityProblems(packet: unknown): readonly string[] {
  if (!isRecord(packet)) return ['client compatibility: must be an object'];
  const problems: string[] = [];
  const current = packet['currentVersion'];
  const previous = packet['previousVersion'];
  if (!Number.isInteger(current) || !Number.isInteger(previous)) {
    problems.push('compatibility: no current and previous client version');
  } else if ((previous as number) >= (current as number)) {
    problems.push('compatibility: the previous version is not older than the current one');
  }

  const clients = Array.isArray(packet['clients']) ? packet['clients'] : [];
  if (clients.length === 0) problems.push('compatibility: no client versions exercised');
  for (const client of clients) {
    const version = isRecord(client) ? client['version'] : undefined;
    const outcome = isRecord(client) ? client['outcome'] : undefined;
    const inWindow = version === current || version === previous;
    if (inWindow && outcome !== 'accepted') {
      problems.push(`client ${version}: a supported client received ${outcome}`);
    }
    if (!inWindow && outcome !== UPDATE_REQUIRED_MESSAGE) {
      problems.push(`client ${version}: an unsupported client received ${outcome} instead of ${UPDATE_REQUIRED_MESSAGE}`);
    }
  }

  const released = packet['releasedInterfaces'];
  for (const name of ['cli', 'corpusApi'] as const) {
    const entry = isRecord(released) && isRecord(released[name]) ? (released[name] as Record<string, unknown>) : {};
    if (entry['intact'] !== true) problems.push(`${name}: released compatibility was broken`);
    const documentedIn = entry['documentedIn'];
    if (typeof documentedIn !== 'string' || documentedIn.trim() === '') {
      problems.push(`${name}: compatibility is not documented separately`);
    }
  }
  return problems;
}
