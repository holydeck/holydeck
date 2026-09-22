import { describe, expect, it } from 'vitest';

import { ENTITY_CONFLICT, VALIDATION_FAILED, errorEnvelope } from '@holydeck/contracts/http';

import { NETWORK_UNREACHABLE, type Refused } from './api.js';
import { refusalKey, refusalText } from './refusal-text.js';

const refused = (code: string): Refused => ({ ok: false, code, message: 'Refused', requestId: 'request-1', fields: [] });

describe('refusal text', () => {
  it.each([
    [refused(ENTITY_CONFLICT), 'workspace.error.conflict'],
    [refused(NETWORK_UNREACHABLE), 'form.error.network'],
    [refused(VALIDATION_FAILED), 'form.error.summary'],
    [refused('media.derivative_missing'), 'preview.error.mediaMissing'],
    [{ ...errorEnvelope('server.failed', 'Failed', 'request-1').error, ok: false, fields: [] } as Refused, 'form.error.unexpected'],
  ] as const)('maps %s to %s', (value, key) => {
    expect(refusalKey(value)).toBe(key);
  });

  it('interpolates an unexpected refusal code', () => {
    expect(refusalText(refused('server.failed'))).toBe('Something went wrong (server.failed). Try again.');
  });
});
