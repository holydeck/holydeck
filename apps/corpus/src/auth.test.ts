import { describe, expect, it } from 'vitest';
import { corpusAuthorization } from '@holydeck/contracts/corpus';
import { HolyDeckError } from '@holydeck/core/messages';
import { requireApiToken } from './auth.js';

const TOKEN = 'a'.repeat(24);

const refusal = (headers: Record<string, unknown>): HolyDeckError | Error => {
  try {
    requireApiToken(headers, TOKEN);
    return new Error('did not refuse');
  } catch (error) {
    return error instanceof Error ? error : new Error('threw something that is not an error');
  }
};

describe('requireApiToken', () => {
  it('accepts the bearer token the internal port was configured with', () => {
    expect(() => requireApiToken({ authorization: corpusAuthorization(TOKEN) }, TOKEN)).not.toThrow();
  });

  it('refuses a request with no token, a wrong token, or another scheme', () => {
    for (const headers of [
      {},
      { authorization: corpusAuthorization('b'.repeat(24)) },
      { authorization: corpusAuthorization(`${TOKEN}extra`) },
      { authorization: `Basic ${TOKEN}` },
      { authorization: TOKEN },
    ]) {
      const error = refusal(headers);
      expect(error instanceof HolyDeckError && error.code).toBe('auth_failed');
    }
  });

  it('says why it refused without repeating any part of what was presented', () => {
    const error = refusal({ authorization: corpusAuthorization('b'.repeat(24)) });
    expect(error.message).toBe('Authentication failed: no matching bearer token was presented.');
    expect(error.message).not.toContain('b'.repeat(24));
  });
});
