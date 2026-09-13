import { describe, expect, test } from 'vitest';

import { FIELD_CODES } from './problems.js';
import {
  ISSUER,
  RECOVERY_ALPHABET,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_GROUP,
  RECOVERY_CODE_LENGTH,
  SECOND_FACTOR,
  TOTP_DIGITS,
  TOTP_DRIFT_STEPS,
  TOTP_PATH,
  TOTP_PERIOD_SECONDS,
  TOTP_RECOVERY_PATH,
  TOTP_VERIFICATION_PATH,
  normalizedCode,
  otpauthUri,
  parseSecondFactor,
} from './totp.js';

describe('what a second factor is managed through', () => {
  test('one resource to enrol in and revoke, and two things done to it', () => {
    expect([TOTP_PATH, TOTP_VERIFICATION_PATH, TOTP_RECOVERY_PATH]).toEqual([
      '/api/v1/totp',
      '/api/v1/totp/verification',
      '/api/v1/totp/recovery',
    ]);
    expect(TOTP_VERIFICATION_PATH.startsWith(`${TOTP_PATH}/`)).toBe(true);
    expect(TOTP_RECOVERY_PATH.startsWith(`${TOTP_PATH}/`)).toBe(true);
  });

  test('the numbers a client shows and a server checks are the ones every authenticator assumes', () => {
    expect({ digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS, drift: TOTP_DRIFT_STEPS }).toEqual({
      digits: 6,
      period: 30,
      drift: 1,
    });
    // A window of one step each way is thirty seconds of clock skew in either direction, which is what a
    // phone that has not synchronised today is off by. Two would double the codes a guess is allowed.
    expect(TOTP_DRIFT_STEPS * TOTP_PERIOD_SECONDS).toBeLessThanOrEqual(30);
  });

  test('ten recovery codes, shown in two halves so a person can read one back', () => {
    expect(RECOVERY_CODE_COUNT).toBe(10);
    expect(RECOVERY_CODE_LENGTH).toBe(10);
    expect(RECOVERY_CODE_GROUP).toBe(5);
    expect(RECOVERY_CODE_LENGTH % RECOVERY_CODE_GROUP).toBe(0);
  });

  test('the alphabet is exactly thirty-two characters, so a byte picks one of them without a bias', () => {
    expect(RECOVERY_ALPHABET).toHaveLength(32);
    expect(new Set(RECOVERY_ALPHABET).size).toBe(32);
    // Fifty bits a code, which is more than anything reached through a counted, locking sign-in.
    expect(RECOVERY_CODE_LENGTH * Math.log2(RECOVERY_ALPHABET.length)).toBeGreaterThanOrEqual(50);
  });
});

describe('reading the code somebody typed', () => {
  test('a code is text, and the shape it has is the store’s to judge rather than this one’s', () => {
    const parsed = parseSecondFactor({ code: '123456' });
    expect(parsed).toEqual({ ok: true, value: { code: '123456' } });
  });

  test('a code typed with the spacing it was shown in is the code that was shown', () => {
    expect(parseSecondFactor({ code: ' 7h4k9-2pq8r ' })).toEqual({ ok: true, value: { code: '7H4K92PQ8R' } });
    expect(normalizedCode('123 456')).toBe('123456');
  });

  test('a code longer than any this server issues is refused before it is looked for', () => {
    const parsed = parseSecondFactor({ code: 'A'.repeat(SECOND_FACTOR.maximum + 1) });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems).toEqual([
      { path: 'secondFactor.code', code: FIELD_CODES.notAllowed, message: `must be at most ${SECOND_FACTOR.maximum} characters` },
    ]);
  });

  test('a body with no code, or one that is not text, is refused as the field it is', () => {
    expect(parseSecondFactor({}).ok).toBe(false);
    expect(parseSecondFactor({ code: 123_456 }).ok).toBe(false);
    expect(parseSecondFactor('123456').ok).toBe(false);
    const empty = parseSecondFactor({ code: '' });
    expect(empty.ok ? [] : empty.problems.map((problem) => problem.code)).toEqual([FIELD_CODES.empty]);
  });
});

describe('what an authenticator is handed', () => {
  test('the URI names the issuer, the account and every parameter, so nothing is assumed', () => {
    const uri = otpauthUri({ secret: 'JBSWY3DPEHPK3PXP', name: 'lucia' });
    expect(uri.startsWith(`otpauth://totp/${ISSUER}:lucia?`)).toBe(true);
    const parameters = new URLSearchParams(uri.slice(uri.indexOf('?') + 1));
    expect(Object.fromEntries(parameters)).toEqual({
      secret: 'JBSWY3DPEHPK3PXP',
      issuer: ISSUER,
      algorithm: 'SHA1',
      digits: String(TOTP_DIGITS),
      period: String(TOTP_PERIOD_SECONDS),
    });
  });

  test('a label that would otherwise end the label early is escaped', () => {
    const uri = otpauthUri({ secret: 'JBSWY3DPEHPK3PXP', name: 'a name: with/trouble' });
    expect(uri).toContain('a%20name%3A%20with%2Ftrouble');
    expect(uri.slice(0, uri.indexOf('?')).split('/').length).toBe(4);
  });
});
