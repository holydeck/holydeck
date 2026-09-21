// The HTTP envelopes every response takes, and the registry of message codes a client is allowed to
// depend on. The rule the contract states is that a released code keeps its meaning and its status
// for the life of the major version: codes may be added and deprecated, never removed or repurposed.
// `messageCodeProblems` is that rule as something that can fail, and the registry below is checked
// against it by this package's own tests and by the application at boot.

import {
  type Parsed,
  type Problem,
  FieldReader,
  isRecord,
  parseObject,
} from './problems.js';

export type MessageCode = {
  readonly code: string;
  readonly status: number;
  readonly stable: boolean;
  readonly since: number;
};

export const VALIDATION_FAILED = 'request.validation_failed';
export const UPDATE_REQUIRED = 'client.update_required';
export const STALE_STATE_REVISION = 'command.stale_state_revision';
export const NOT_FOUND = 'resource.not_found';

/**
 * Archiving an entity that is already hidden, bringing back one that was never hidden, or saving one a
 * second writer has moved on since. All three are a request that disagrees with the state it is aimed at,
 * which is what 409 says — and none of them is the stale state revision a live command carries.
 *
 * Named for the situation rather than for the first entity to reach it: every versioned surface after
 * Slide Layouts refuses the same three things, and a code per entity would say the same sentence in as
 * many ways as there are entities.
 */
export const ENTITY_CONFLICT = 'entity.state_conflict';

/**
 * The one code a fault of this server's own takes. A client is told that the request did not happen and
 * nothing more: the sentence a thrown error carries is written for an operator reading a log, and it has
 * been known to carry a connection string with it.
 */
export const UNEXPECTED_ERROR = 'server.unexpected_error';

export const MESSAGE_CODES: readonly MessageCode[] = [
  { code: VALIDATION_FAILED, status: 422, stable: true, since: 1 },
  { code: 'auth.session.expired', status: 401, stable: true, since: 1 },
  { code: 'auth.sign_in_refused', status: 401, stable: true, since: 1 },
  // A second factor that did not match, which is one code for a wrong digit, a reused one and a code for
  // an enrolment that is not there: what a refusal must not say is which of those it was.
  { code: 'auth.totp_refused', status: 401, stable: true, since: 1 },
  // A ceremony that did not verify: a signature that is not that key's, a challenge nobody issued or
  // that was answered already, and a key this deployment does not hold. One code for all of them.
  { code: 'auth.passkey_refused', status: 401, stable: true, since: 1 },
  { code: 'auth.forbidden', status: 403, stable: true, since: 1 },
  // Enrolling over a second factor that is already proved, and asking of one that was never enrolled.
  // Both are a request that disagrees with the state it is aimed at, which is what 409 says.
  { code: 'auth.totp_enrolled', status: 409, stable: true, since: 1 },
  { code: 'auth.totp_missing', status: 409, stable: true, since: 1 },
  // Registering a key this deployment already holds, and registering one over the account's ceiling.
  { code: 'auth.passkey_registered', status: 409, stable: true, since: 1 },
  { code: 'auth.passkey_limit', status: 409, stable: true, since: 1 },
  { code: NOT_FOUND, status: 404, stable: true, since: 1 },
  { code: UPDATE_REQUIRED, status: 426, stable: true, since: 1 },
  { code: STALE_STATE_REVISION, status: 409, stable: true, since: 1 },
  { code: ENTITY_CONFLICT, status: 409, stable: true, since: 1 },
  // The corpus boundary. These are what a client learns when the application could not read the corpus;
  // the corpus's own codes and wording stay behind the boundary, and `./corpus.js` holds the translation.
  { code: 'corpus.reference.malformed', status: 422, stable: true, since: 1 },
  { code: 'corpus.reference.not_found', status: 404, stable: true, since: 1 },
  { code: 'corpus.translation.unknown', status: 404, stable: true, since: 1 },
  { code: 'corpus.revision.not_found', status: 404, stable: true, since: 1 },
  { code: 'corpus.unavailable', status: 503, stable: true, since: 1 },
  { code: 'corpus.upstream.unavailable', status: 502, stable: true, since: 1 },
  { code: 'corpus.unexpected_error', status: 500, stable: true, since: 1 },
  { code: UNEXPECTED_ERROR, status: 500, stable: true, since: 1 },
];

/** Codes withdrawn from the registry. A released code is deprecated in documentation, never removed. */
export const REMOVED_CODES: readonly string[] = [];

export const ENVELOPE_CODES = {
  mixed: 'envelope.mixed',
  unstableCode: 'envelope.unstable_code',
  noFields: 'envelope.no_fields',
} as const;

export type FieldProblem = { readonly path: string; readonly code: string; readonly message: string };

export type SuccessEnvelope<T> = {
  readonly data: T;
  readonly meta: { readonly requestId: string; readonly version?: number };
};

/**
 * What a fault actually was, for a developer running this deployment themselves.
 *
 * Never part of an ordinary answer. The sentence a thrown error carries is written for whoever reads the
 * log — it has been known to hold a connection string, a path on the host, a credential — and this shape
 * exists so that a deployment which has deliberately turned diagnostics on gets it in a documented field
 * rather than in the `message` a client is meant to be able to show somebody.
 *
 * Optional rather than nulled out when absent, so an envelope from an installation that does not have
 * diagnostics enabled is byte-for-byte the envelope of one that has never heard of them.
 */
export type ErrorDiagnostics = {
  readonly message: string;
  readonly stack?: string;
};

export type ErrorEnvelope = {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly fields?: readonly FieldProblem[];
    /** Present only where the deployment itself turned developer diagnostics on. See above. */
    readonly diagnostics?: ErrorDiagnostics;
  };
};

export const VALIDATION_MESSAGE = 'The request could not be accepted.';

export function statusForCode(code: string): number | undefined {
  return MESSAGE_CODES.find((entry) => entry.code === code)?.status;
}

export function successEnvelope<T>(data: T, requestId: string, version?: number): SuccessEnvelope<T> {
  return { data, meta: version === undefined ? { requestId } : { requestId, version } };
}

export function errorEnvelope(
  code: string,
  message: string,
  requestId: string,
  fields?: readonly FieldProblem[],
): ErrorEnvelope {
  return { error: fields === undefined ? { code, message, requestId } : { code, message, requestId, fields } };
}

/** The one envelope a rejected payload takes: the stable code, and every field that was refused. */
export function validationFailure(requestId: string, problems: readonly Problem[]): ErrorEnvelope {
  return errorEnvelope(
    VALIDATION_FAILED,
    VALIDATION_MESSAGE,
    requestId,
    problems.map((problem) => ({ path: problem.path, code: problem.code, message: problem.message })),
  );
}

const parseFieldProblem = (value: unknown, path: string): Parsed<FieldProblem> =>
  parseObject(value, path, (reader) => ({
    path: reader.text('path'),
    code: reader.text('code'),
    message: reader.text('message'),
  }));

const readMeta = (reader: FieldReader) => ({
  requestId: reader.text('requestId'),
  version: reader.optionalWholeNumber('version', 1),
});

export function parseSuccessEnvelope(value: unknown, path = 'success'): Parsed<SuccessEnvelope<unknown>> {
  return parseObject(value, path, (reader) => ({
    data: reader.present('data'),
    meta: reader.parsed('meta', (raw, at) => parseObject(raw, at, readMeta), { requestId: '', version: undefined }),
  }));
}

const readErrorBody = (reader: FieldReader) => ({
  code: reader.text('code'),
  message: reader.text('message'),
  requestId: reader.text('requestId'),
  fields: reader.optionalParsedList('fields', parseFieldProblem),
});

export function parseErrorEnvelope(value: unknown, path = 'error'): Parsed<ErrorEnvelope> {
  return parseObject(value, path, (reader) => {
    reader.absent('data', ENVELOPE_CODES.mixed, 'must not carry data as well as an error');
    return {
      error: reader.parsed('error', (raw, at) => parseObject(raw, at, readErrorBody), {
        code: '',
        message: '',
        requestId: '',
        fields: undefined,
      }),
    };
  });
}

const readValidationBody = (reader: FieldReader) => {
  const code = reader.text('code');
  const message = reader.text('message');
  const requestId = reader.text('requestId');
  if (code !== '' && code !== VALIDATION_FAILED) {
    reader.reject('code', ENVELOPE_CODES.unstableCode, `must be ${VALIDATION_FAILED}`);
  }
  const before = reader.problems.length;
  const fields = reader.parsedList('fields', parseFieldProblem);
  if (fields.length === 0 && reader.problems.length === before) {
    reader.reject('fields', ENVELOPE_CODES.noFields, 'must name at least one field');
  }
  return { code, message, requestId, fields };
};

export function parseValidationFailure(value: unknown, path = 'validationFailure'): Parsed<ErrorEnvelope> {
  return parseObject(value, path, (reader) => ({
    error: reader.parsed('error', (raw, at) => parseObject(raw, at, readValidationBody), {
      code: '',
      message: '',
      requestId: '',
      fields: [],
    }),
  }));
}

const CODE_ENTRY = (value: unknown, path: string): Parsed<MessageCode> =>
  parseObject(value, path, (reader) => ({
    code: reader.text('code'),
    status: reader.wholeNumber('status', 100),
    stable: reader.flag('stable'),
    since: reader.wholeNumber('since', 1),
  }));

/** Grades a message-code registry against the compatibility rule the contract states. */
export function messageCodeProblems(codes: unknown, removedCodes: unknown): readonly string[] {
  const problems: string[] = [];
  const reader = new FieldReader({ codes, removedCodes }, '');
  const entries = reader.parsedList('codes', CODE_ENTRY);
  const removed = reader.textList('removedCodes');
  if (reader.problems.length > 0) return reader.problems.map((problem) => `${problem.path}: ${problem.message}`);

  if (entries.length === 0) problems.push('message codes: the registry is empty');
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.stable) problems.push(`message code ${entry.code}: is not marked stable`);
    if (seen.has(entry.code)) problems.push(`message code ${entry.code}: declared twice`);
    seen.add(entry.code);
  }
  for (const code of removed) problems.push(`message code ${code}: was removed rather than deprecated`);
  return problems;
}

const CONTRACT_DIAGNOSTICS: Readonly<Record<string, string>> = {
  'success.data': 'success envelope: has no data',
  'success.meta.requestId': 'success envelope: has no request id',
  'error.data': 'error envelope: carries data as well as an error',
  'error.error.code': 'error envelope: has no code',
  'validationFailure.error.code': 'validation failure: does not use the stable validation code',
  'validationFailure.error.fields': 'validation failure: names no field',
};

const VALIDATION_FIELD_PATH = /^validationFailure\.error\.fields\.\d+\.path$/u;

const describeProblem = (problem: Problem): string => {
  if (VALIDATION_FIELD_PATH.test(problem.path)) return 'validation field ?: has no path';
  return CONTRACT_DIAGNOSTICS[problem.path] ?? `${problem.path}: ${problem.message}`;
};

/**
 * Grades a whole HTTP contract recording — the two envelopes, the validation failure, and the code
 * registry — and reports it in the words the contract's own acceptance criterion uses.
 */
export function httpContractProblems(packet: unknown): readonly string[] {
  if (!isRecord(packet)) return ['http contract: must be an object'];
  const problems: string[] = [];
  const envelopes = [
    parseSuccessEnvelope(packet['success']),
    parseErrorEnvelope(packet['error']),
    parseValidationFailure(packet['validationFailure']),
  ];
  for (const parsed of envelopes) {
    if (!parsed.ok) problems.push(...parsed.problems.map(describeProblem));
  }
  return [...problems, ...messageCodeProblems(packet['codes'], packet['removedCodes'])];
}
