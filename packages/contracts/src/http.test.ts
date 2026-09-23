import { describe, expect, it } from 'vitest';

import {
  ENTITY_CONFLICT,
  MESSAGE_CODES,
  REMOVED_CODES,
  STALE_STATE_REVISION,
  UPDATE_REQUIRED,
  VALIDATION_FAILED,
  errorEnvelope,
  httpContractProblems,
  locatedValidationFailure,
  messageCodeProblems,
  parseErrorEnvelope,
  parseSuccessEnvelope,
  parseValidationFailure,
  successEnvelope,
  validationFailure,
} from './http.js';

// The recording in contracts/fixtures/http.v1.json, which is what AC-http-1 is graded against. It is
// written out here rather than imported, because the product repository holds no phase artifacts; the
// counterexamples below are the fixture's own defects, one deliberate defect each.
const packet = () => ({
  success: { data: { id: 'service-1', title: 'Sunday morning' }, meta: { requestId: 'req-8f21', version: 1 } },
  error: { error: { code: 'auth.session.expired', message: 'Sign in again to continue.', requestId: 'req-8f22' } },
  validationFailure: {
    error: {
      code: 'request.validation_failed',
      message: 'The request could not be accepted.',
      requestId: 'req-8f23',
      fields: [
        { path: 'service.title', code: 'field.required', message: 'Give the service a title.' },
        { path: 'service.startsAt', code: 'field.not_a_time', message: 'Use a date and time.' },
      ],
    },
  },
  codes: [
    { code: 'request.validation_failed', status: 422, stable: true, since: 1 },
    { code: 'auth.session.expired', status: 401, stable: true, since: 1 },
    { code: 'auth.forbidden', status: 403, stable: true, since: 1 },
    { code: 'resource.not_found', status: 404, stable: true, since: 1 },
    { code: 'client.update_required', status: 426, stable: true, since: 1 },
    { code: 'command.stale_state_revision', status: 409, stable: true, since: 1 },
  ],
  removedCodes: [] as string[],
});

describe('the released message codes', () => {
  it('carries every code the contract recorded, each mapped to one status', () => {
    expect(MESSAGE_CODES.map((entry) => [entry.code, entry.status])).toEqual([
      ['request.validation_failed', 422],
      ['auth.session.expired', 401],
      ['auth.sign_in_refused', 401],
      ['auth.totp_refused', 401],
      ['auth.passkey_refused', 401],
      ['auth.forbidden', 403],
      ['auth.totp_enrolled', 409],
      ['auth.totp_missing', 409],
      ['auth.passkey_registered', 409],
      ['auth.passkey_limit', 409],
      ['resource.not_found', 404],
      ['client.update_required', 426],
      ['command.stale_state_revision', 409],
      ['entity.state_conflict', 409],
      ['corpus.reference.malformed', 422],
      ['corpus.reference.not_found', 404],
      ['corpus.translation.unknown', 404],
      ['corpus.revision.not_found', 404],
      ['corpus.unavailable', 503],
      ['corpus.upstream.unavailable', 502],
      ['corpus.unexpected_error', 500],
      ['media.too_large', 413],
      ['server.unexpected_error', 500],
      ['run.not_ready', 409],
      ['run.snapshot_outdated', 409],
      ['run.already_active', 409],
      ['run.ended', 409],
      ['theme.contrast', 422],
    ]);
    expect([VALIDATION_FAILED, UPDATE_REQUIRED, STALE_STATE_REVISION, ENTITY_CONFLICT]).toEqual([
      'request.validation_failed',
      'client.update_required',
      'command.stale_state_revision',
      'entity.state_conflict',
    ]);
  });

  it('holds its own registry to the rule it states, so a released code cannot quietly move', () => {
    expect(messageCodeProblems(MESSAGE_CODES, REMOVED_CODES)).toEqual([]);
  });

  it('refuses a registry that is unstable, repeated, removed, or not a registry at all', () => {
    expect(messageCodeProblems([{ code: 'a.b', status: 400, stable: false, since: 1 }], [])).toEqual([
      'message code a.b: is not marked stable',
    ]);
    expect(
      messageCodeProblems(
        [
          { code: 'a.b', status: 400, stable: true, since: 1 },
          { code: 'a.b', status: 409, stable: true, since: 1 },
        ],
        [],
      ),
    ).toEqual(['message code a.b: declared twice']);
    expect(messageCodeProblems(MESSAGE_CODES, ['auth.session.expired'])).toEqual([
      'message code auth.session.expired: was removed rather than deprecated',
    ]);
    expect(messageCodeProblems([], [])).toEqual(['message codes: the registry is empty']);
    expect(messageCodeProblems([{ code: 'a.b', status: 99, stable: true, since: 1 }], [])).toEqual([
      'codes.0.status: must be at least 100',
    ]);
    expect(messageCodeProblems('codes', [])).toEqual(['codes: must be a list']);
    expect(messageCodeProblems(MESSAGE_CODES, 'none')).toEqual(['removedCodes: must be a list']);
  });
});

describe('envelopes', () => {
  it('builds a success envelope a reader can parse back', () => {
    const envelope = successEnvelope({ id: 'service-1' }, 'req-1');
    expect(envelope).toEqual({ data: { id: 'service-1' }, meta: { requestId: 'req-1' } });
    expect(parseSuccessEnvelope(envelope)).toEqual({ ok: true, value: envelope });
    expect(successEnvelope(null, 'req-1', 2).meta.version).toBe(2);
  });

  it('builds an error envelope a reader can parse back', () => {
    const envelope = errorEnvelope('auth.forbidden', 'You cannot do that.', 'req-2');
    expect(envelope).toEqual({ error: { code: 'auth.forbidden', message: 'You cannot do that.', requestId: 'req-2' } });
    expect(parseErrorEnvelope(envelope)).toEqual({ ok: true, value: envelope });
  });

  it('keeps the line and column of a problem found in raw text, and leaves them out where there is none', () => {
    const failure = locatedValidationFailure('req-4', [
      { path: 'sections', code: 'field.invalid', message: 'Unknown label', at: { line: 3, column: 5 } },
      { path: 'titles', code: 'field.required', message: 'is required' },
    ]);
    expect(failure.error.fields).toEqual([
      { path: 'sections', code: 'field.invalid', message: 'Unknown label', line: 3, column: 5 },
      { path: 'titles', code: 'field.required', message: 'is required' },
    ]);
    expect(parseValidationFailure(failure)).toEqual({ ok: true, value: failure });
  });

  it('turns the problems a parser found into a validation failure that names each field', () => {
    const failure = validationFailure('req-3', [
      { path: 'service.title', code: 'field.required', message: 'is required' },
    ]);
    expect(failure).toEqual({
      error: {
        code: VALIDATION_FAILED,
        message: 'The request could not be accepted.',
        requestId: 'req-3',
        fields: [{ path: 'service.title', code: 'field.required', message: 'is required' }],
      },
    });
    expect(parseValidationFailure(failure)).toEqual({ ok: true, value: failure });
  });

  it('reads dropped off a success envelope that carries it, as a route revalidating a position does', () => {
    const envelope = { data: { position: {} }, meta: { requestId: 'req-9', dropped: ['itemId', 'slideId'] } };
    expect(parseSuccessEnvelope(envelope)).toEqual({ ok: true, value: envelope });
  });

  it('refuses a success envelope that is not one', () => {
    const parsed = parseSuccessEnvelope({ meta: {} });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.problems).toEqual([
      { path: 'success.data', code: 'field.required', message: 'is required' },
      { path: 'success.meta.requestId', code: 'field.required', message: 'is required' },
    ]);
  });

  it('refuses an error envelope that carries data as well', () => {
    const parsed = parseErrorEnvelope({ data: {}, error: { code: 'a.b', message: 'm', requestId: 'r' } });
    expect(parsed.ok === false && parsed.problems).toEqual([
      { path: 'error.data', code: 'envelope.mixed', message: 'must not carry data as well as an error' },
    ]);
  });

  it('keeps the field list optional on a plain error and typed when it is there', () => {
    expect(parseErrorEnvelope({ error: { code: 'a.b', message: 'm', requestId: 'r', fields: [{ path: 'p' }] } })).toEqual({
      ok: false,
      problems: [
        { path: 'error.error.fields.0.code', code: 'field.required', message: 'is required' },
        { path: 'error.error.fields.0.message', code: 'field.required', message: 'is required' },
      ],
    });
  });

  it('refuses a validation failure that does not use the stable code', () => {
    const parsed = parseValidationFailure({
      error: { code: 'oops', message: 'm', requestId: 'r', fields: [{ path: 'p', code: 'c', message: 'm' }] },
    });
    expect(parsed.ok === false && parsed.problems).toEqual([
      {
        path: 'validationFailure.error.code',
        code: 'envelope.unstable_code',
        message: `must be ${VALIDATION_FAILED}`,
      },
    ]);
  });
});

describe('the contract itself', () => {
  it('accepts the recording the contract was written from', () => {
    expect(httpContractProblems(packet())).toEqual([]);
  });

  const refuses = (name: string, defect: (value: ReturnType<typeof packet>) => void, diagnostics: readonly string[]) => {
    it(`refuses ${name}`, () => {
      const value = packet();
      defect(value);
      expect(httpContractProblems(value)).toEqual(diagnostics);
    });
  };

  refuses('a success envelope with no request id', (value) => {
    delete (value.success.meta as { requestId?: string }).requestId;
  }, ['success envelope: has no request id']);

  refuses('a success envelope with no data', (value) => {
    delete (value.success as { data?: unknown }).data;
  }, ['success envelope: has no data']);

  refuses('an error envelope carrying data as well', (value) => {
    (value.error as { data?: unknown }).data = { id: 'service-1' };
  }, ['error envelope: carries data as well as an error']);

  refuses('an error envelope with no stable code', (value) => {
    delete (value.error.error as { code?: string }).code;
  }, ['error envelope: has no code']);

  refuses('a validation failure using an ad-hoc code', (value) => {
    value.validationFailure.error.code = 'title_missing';
  }, ['validation failure: does not use the stable validation code']);

  refuses('a validation failure naming no field', (value) => {
    value.validationFailure.error.fields = [];
  }, ['validation failure: names no field']);

  refuses('a validation field with no path', (value) => {
    delete (value.validationFailure.error.fields[0] as { path?: string }).path;
  }, ['validation field ?: has no path']);

  refuses('a message code that is not stable', (value) => {
    (value.codes[1] as { stable: boolean }).stable = false;
  }, ['message code auth.session.expired: is not marked stable']);

  refuses('a message code declared twice', (value) => {
    value.codes.push({ code: 'request.validation_failed', status: 422, stable: true, since: 1 });
  }, ['message code request.validation_failed: declared twice']);

  refuses('a message code removed rather than deprecated', (value) => {
    value.codes.splice(1, 1);
    value.removedCodes.push('auth.session.expired');
  }, ['message code auth.session.expired: was removed rather than deprecated']);

  it('reports a defect the criterion never rehearsed rather than letting it through unnamed', () => {
    const value = packet();
    delete (value.error.error as { message?: string }).message;
    expect(httpContractProblems(value)).toEqual(['error.error.message: is required']);
  });

  it('refuses a packet that is not a packet', () => {
    expect(httpContractProblems('nothing')).toEqual(['http contract: must be an object']);
  });
});
