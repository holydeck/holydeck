import {
  CORPUS_AUTH_HEADER,
  CORPUS_UNEXPECTED,
  CORPUS_UNEXPECTED_STATUS,
  INTERNAL_BINDINGS,
  corpusAuthorization,
  corpusBoundary,
  corpusFailureMapping,
  parseCorpusFailure,
  parseCorpusTranslations,
} from '@holydeck/contracts/corpus';

import type { CorpusBoundaryPacket, CorpusTranslation } from '@holydeck/contracts/corpus';

/**
 * The only way this application talks to the corpus service.
 *
 * Two rules hold everything here together. The corpus is reachable from inside the deployment and
 * nowhere else, so its address is graded against the documented boundary before the application will
 * run. And nothing the corpus says reaches a client: every failure is translated into a code this
 * application publishes, with wording written here, because a corpus message names stores, jobs and
 * upstream sites that a congregation has no business reading and an attacker would like to. A
 * failure with no translation is refused as unexpected rather than forwarded.
 */

export interface CorpusSettings {
  readonly url: string;
  readonly token: string;
}

export interface CorpusRefusal {
  readonly code: string;
  readonly status: number;
  readonly message: string;
}

export type CorpusResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: CorpusRefusal };

export interface CorpusAnswer {
  readonly status: number;
  json(): Promise<unknown>;
}

export type Fetching = (url: string, init: { readonly headers: Readonly<Record<string, string>> }) => Promise<CorpusAnswer>;

/**
 * What a client is told when the library could not answer. Every code the contract publishes under
 * `corpus.` has an entry, checked in both directions, so a new code cannot be served as `undefined`.
 */
export const CORPUS_WORDING = {
  'corpus.reference.malformed': 'That reference could not be read.',
  'corpus.reference.not_found': 'That passage is not in the library yet.',
  'corpus.translation.unknown': 'That translation is not one the library holds.',
  'corpus.revision.not_found': 'That revision of the library is no longer available.',
  'corpus.unavailable': 'The library is not available right now.',
  'corpus.upstream.unavailable': 'The library could not reach the source it needs.',
  'corpus.unexpected_error': 'The library answered in a way this application could not use.',
} as const satisfies Record<string, string>;

type CorpusCode = keyof typeof CORPUS_WORDING;

const refusal = (code: CorpusCode, status: number): CorpusRefusal => ({ code, status, message: CORPUS_WORDING[code] });

export const LIBRARY_UNAVAILABLE = refusal('corpus.unavailable', 503);
export const LIBRARY_UNEXPECTED = refusal(CORPUS_UNEXPECTED, CORPUS_UNEXPECTED_STATUS);
export const LIBRARY_NOT_CONFIGURED: CorpusRefusal = {
  ...LIBRARY_UNAVAILABLE,
  message: 'No scripture library is configured for this deployment.',
};

const TRANSLATIONS_PATH = '/api/v1/translations';
const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '[::1]'];

/** Written as arithmetic rather than as a pattern, so no address of anyone's ends up in this file. */
function isPrivateAddress(host: string): boolean {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = octets as [number, number, number, number];
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

/** The documented binding an address belongs to, or the host itself when it belongs to none. */
export function corpusBinding(url: string): string {
  const { hostname } = new URL(url);
  if (LOOPBACK.includes(hostname)) return 'loopback';
  // A name with no dots is a name only this deployment's network resolves, which is what a compose
  // service or a cluster service is; anything else is a name the rest of the world can resolve too.
  if (!hostname.includes('.') || isPrivateAddress(hostname)) return 'internal-network';
  return hostname;
}

/** The boundary packet this deployment presents, for the documented check to grade. */
export function corpusBoundaryFor(settings: CorpusSettings): CorpusBoundaryPacket {
  const binding = corpusBinding(settings.url);
  return corpusBoundary({
    binding,
    publiclyRoutable: !INTERNAL_BINDINGS.some((internal) => internal === binding),
    authenticated: settings.token !== '',
  });
}

const addressOf = (url: string): string => url.replace(/\/+$/u, '');

function translate(body: unknown): CorpusRefusal {
  const failure = parseCorpusFailure(body);
  if (!failure.ok) return LIBRARY_UNEXPECTED;
  const mapping = corpusFailureMapping(failure.value.code);
  if (mapping === undefined) return LIBRARY_UNEXPECTED;
  // Every mapping names a published code, and every published code has wording; both are held by a
  // test on each side of the boundary, which is what makes this lookup a lookup and not a guess.
  return refusal(mapping.code as CorpusCode, mapping.http);
}

export function corpusClient(settings: CorpusSettings, fetching: Fetching): {
  translations(): Promise<CorpusResult<readonly CorpusTranslation[]>>;
} {
  const address = addressOf(settings.url);

  async function ask(path: string): Promise<CorpusResult<unknown>> {
    if (settings.url === '') return { ok: false, refusal: LIBRARY_NOT_CONFIGURED };
    let answer: CorpusAnswer;
    try {
      answer = await fetching(`${address}${path}`, {
        headers: { [CORPUS_AUTH_HEADER]: corpusAuthorization(settings.token) },
      });
    } catch {
      return { ok: false, refusal: LIBRARY_UNAVAILABLE };
    }
    let body: unknown;
    try {
      body = await answer.json();
    } catch {
      return { ok: false, refusal: LIBRARY_UNEXPECTED };
    }
    if (answer.status >= 200 && answer.status < 300) return { ok: true, value: body };
    return { ok: false, refusal: translate(body) };
  }

  return {
    async translations() {
      const answer = await ask(TRANSLATIONS_PATH);
      if (!answer.ok) return answer;
      const parsed = parseCorpusTranslations(answer.value);
      return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, refusal: LIBRARY_UNEXPECTED };
    },
  };
}

export interface CorpusProbe {
  readonly reached: boolean;
  readonly closed: boolean;
  readonly detail: string;
}

/**
 * Asks a released route with no credential and expects to be refused. A corpus that answers is
 * exposed to anything that can reach it, which is a deployment fault this application will not run
 * through; a corpus that is not up yet is not a fault, because start-up order is not a guarantee.
 */
export async function probeCorpusIsClosed(settings: CorpusSettings, fetching: Fetching): Promise<CorpusProbe> {
  if (settings.url === '') return { reached: false, closed: false, detail: 'no library is configured' };
  const address = addressOf(settings.url);
  try {
    const answer = await fetching(`${address}${TRANSLATIONS_PATH}`, { headers: {} });
    if (answer.status === 401) return { reached: true, closed: true, detail: `${address} refused an unauthenticated request` };
    return {
      reached: true,
      closed: false,
      detail: `${address} answered an unauthenticated request with ${answer.status}; the internal API must require a credential`,
    };
  } catch {
    return { reached: false, closed: false, detail: `${address} could not be reached` };
  }
}

export function corpusProbeProblems(probe: CorpusProbe): readonly string[] {
  return probe.reached && !probe.closed ? [probe.detail] : [];
}
