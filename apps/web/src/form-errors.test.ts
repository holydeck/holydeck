// The form-error boundary is deliberately tested without rendering: its responsibility is deciding which
// server paths a form owns and which answer must remain page-level before any component places the result.

import { describe, expect, it } from 'vitest';

import { NETWORK_UNREACHABLE, type Refused } from './api.js';
import { fieldErrors } from './form-errors.js';

const refused = (fields: Refused['fields'], code = 'request.validation_failed'): Refused => ({
  ok: false,
  code,
  message: 'The request was refused.',
  requestId: 'request-1',
  fields,
});

describe('fieldErrors', () => {
  it('maps recognised final path segments and leaves the first other problem at page level', () => {
    const result = fieldErrors(refused([
      { path: 'claim.name', code: 'field.not_allowed', message: 'Use a different handle.' },
      { path: 'claim.role', code: 'field.not_allowed', message: 'That role is unavailable.' },
      { path: 'claim.password', code: 'field.too_small', message: 'Use a longer password.' },
    ]), ['name', 'password']);

    expect(result).toEqual({
      byField: { name: 'Use a different handle.', password: 'Use a longer password.' },
      other: 'That role is unavailable.',
    });
  });

  it('uses a safe translated message when a refusal has no field problem to place', () => {
    expect(fieldErrors(refused([], NETWORK_UNREACHABLE), [])).toEqual({
      byField: {},
      other: 'The server could not be reached. Check the connection and try again.',
    });
    expect(fieldErrors(refused([], 'server.unexpected_error'), [])).toEqual({
      byField: {},
      other: 'Something went wrong (server.unexpected_error). Try again.',
    });
  });
});
