// The one place the web client talks to the application. Every request says which contract it speaks,
// every answer is parsed before anything is rendered from it, and nothing here throws: an answer the
// client cannot read is a result it can show, not an exception in the middle of a live service.

import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { type FieldProblem, UPDATE_REQUIRED, parseErrorEnvelope, parseSuccessEnvelope } from '@holydeck/contracts/http';
import type { Problem } from '@holydeck/contracts/problems';

export interface ResponseLike {
  readonly status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: { readonly headers: Record<string, string> }) => Promise<ResponseLike>;

/** Said by the client, never by the server: the answer arrived but was not the answer it promised. */
export const UNREADABLE_RESPONSE = 'client.unreadable_response';

/** Said by the client when the request never got an answer at all. */
export const NETWORK_UNREACHABLE = 'client.network_unreachable';

export type Refused = {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
  readonly fields: readonly FieldProblem[];
};

export type Answered<T> = {
  readonly ok: true;
  readonly data: T;
  readonly requestId: string;
  readonly version: number | undefined;
};

export type ApiResult<T> = Answered<T> | Refused;

const asFields = (problems: readonly Problem[]): readonly FieldProblem[] =>
  problems.map((problem) => ({ path: problem.path, code: problem.code, message: problem.message }));

const unreadable = (problems: readonly Problem[]): Refused => ({
  ok: false,
  code: UNREADABLE_RESPONSE,
  message: problems.map((problem) => `${problem.path} ${problem.message}`).join('; '),
  requestId: '',
  fields: asFields(problems),
});

const failed = (code: string, message: string): Refused => ({ ok: false, code, message, requestId: '', fields: [] });

export async function ask(path: string, fetching: FetchLike): Promise<ApiResult<unknown>> {
  let response: ResponseLike;
  let body: unknown;
  try {
    response = await fetching(path, { headers: { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current) } });
    body = await response.json();
  } catch (error) {
    // A rejected fetch is an unreachable network; a rejected read is a body that was not the JSON the
    // contract promises, which a captive portal or a proxy error page is the usual cause of.
    const message = error instanceof Error ? error.message : String(error);
    return failed(error instanceof TypeError ? NETWORK_UNREACHABLE : UNREADABLE_RESPONSE, message);
  }

  if (response.status >= 200 && response.status < 300) {
    const parsed = parseSuccessEnvelope(body);
    return parsed.ok
      ? { ok: true, data: parsed.value.data, requestId: parsed.value.meta.requestId, version: parsed.value.meta.version }
      : unreadable(parsed.problems);
  }

  const parsed = parseErrorEnvelope(body);
  if (!parsed.ok) return unreadable(parsed.problems);
  const { code, message, requestId, fields } = parsed.value.error;
  return { ok: false, code, message, requestId, fields: fields ?? [] };
}

/** True when the refusal is the one no retry can fix: this client is older than the server serves. */
export function needsUpdate(result: ApiResult<unknown>): boolean {
  return !result.ok && result.code === UPDATE_REQUIRED;
}
