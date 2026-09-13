import {
  RECOVERY_ALPHABET,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
} from '@holydeck/contracts/totp';
import { describe, expect, test } from 'vitest';

import {
  BASE32_ALPHABET,
  OtpError,
  SECRET_BYTES,
  codeAt,
  decodedSecret,
  drawnRecoveryCodes,
  drawnSecret,
  encodedSecret,
  matchedStep,
  recoveryDigest,
  sameDigest,
  stepAt,
} from './otp.js';

// RFC 6238's own test vectors, which every implementation is expected to answer. The seed is the ASCII
// string the RFC names; the codes are its eight-digit ones, of which this deployment shows the last six.
const SEED = Buffer.from('12345678901234567890');
const VECTORS = [
  { seconds: 59, code: '287082' },
  { seconds: 1_111_111_109, code: '081804' },
  { seconds: 1_111_111_111, code: '050471' },
  { seconds: 1_234_567_890, code: '005924' },
  { seconds: 2_000_000_000, code: '279037' },
  { seconds: 20_000_000_000, code: '353130' },
] as const;

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const momentOf = (seconds: number): string => new Date(seconds * 1000).toISOString();

describe('the secret a second factor is', () => {
  test('is written the way every authenticator reads one, and is read back byte for byte', () => {
    expect(encodedSecret(SEED)).toBe(SECRET);
    expect(decodedSecret(SECRET)).toEqual(SEED);
    expect(BASE32_ALPHABET).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
  });

  test('is drawn at the length RFC 4226 asks for, and is a different secret every time', () => {
    const drawn = drawnSecret();
    expect(SECRET_BYTES).toBeGreaterThanOrEqual(20);
    expect(decodedSecret(drawn)).toHaveLength(SECRET_BYTES);
    expect(drawn).not.toBe(drawnSecret());
  });

  test('is never written from bytes that do not fill whole groups, which this code never has', () => {
    expect(() => encodedSecret(Buffer.alloc(7))).toThrow(OtpError);
  });

  test('is a defect when what was stored is not a secret this code could have written', () => {
    // Lower case, a character base32 does not have, and a length no whole number of bytes encodes to.
    for (const stored of ['gezdgnbv', 'AAAAAAA1', 'AAAAA']) {
      expect(() => decodedSecret(stored)).toThrow(OtpError);
    }
  });
});

describe('the code a second factor gives', () => {
  test('is the one RFC 6238 publishes for its own vectors, at every moment it publishes', () => {
    for (const vector of VECTORS) {
      expect(codeAt(SECRET, stepAt(momentOf(vector.seconds)))).toBe(vector.code);
    }
  });

  test('is as many digits as every authenticator shows, and keeps the zeroes it begins with', () => {
    const code = codeAt(SECRET, stepAt(momentOf(1_234_567_890)));
    expect(code).toHaveLength(TOTP_DIGITS);
    expect(code.startsWith('0')).toBe(true);
  });

  test('is a new code every thirty seconds, counted from the epoch', () => {
    expect(stepAt('1970-01-01T00:00:00.000Z')).toBe(0);
    expect(stepAt(momentOf(TOTP_PERIOD_SECONDS - 1))).toBe(0);
    expect(stepAt(momentOf(TOTP_PERIOD_SECONDS))).toBe(1);
  });

  test('is a defect when the moment or the step it is asked for is not one', () => {
    expect(() => stepAt('the ninth of never')).toThrow(OtpError);
    expect(() => stepAt('1969-12-31T23:59:59.000Z')).toThrow(OtpError);
    expect(() => codeAt(SECRET, -1)).toThrow(OtpError);
    expect(() => codeAt(SECRET, 1.5)).toThrow(OtpError);
  });
});

describe('the code a person typed', () => {
  const NOW = momentOf(1_234_567_890);
  const STEP = stepAt(NOW);

  test('is matched at the step it was shown at, and the step it matched is the answer', () => {
    expect(matchedStep(SECRET, codeAt(SECRET, STEP), NOW)).toBe(STEP);
  });

  test('is matched one step early and one step late, because a phone’s clock drifts', () => {
    expect(matchedStep(SECRET, codeAt(SECRET, STEP - 1), NOW)).toBe(STEP - 1);
    expect(matchedStep(SECRET, codeAt(SECRET, STEP + 1), NOW)).toBe(STEP + 1);
  });

  test('is not matched two steps out, which is a code old enough that somebody else may have it', () => {
    expect(matchedStep(SECRET, codeAt(SECRET, STEP - 2), NOW)).toBeUndefined();
    expect(matchedStep(SECRET, codeAt(SECRET, STEP + 2), NOW)).toBeUndefined();
  });

  test('is not matched when it is not a code at all, and costs no derivation when it is not', () => {
    expect(matchedStep(SECRET, '', NOW)).toBeUndefined();
    expect(matchedStep(SECRET, '12345', NOW)).toBeUndefined();
    expect(matchedStep(SECRET, '1234567', NOW)).toBeUndefined();
    expect(matchedStep(SECRET, '000000'.replace('0', 'A'), NOW)).toBeUndefined();
  });
});

describe('the codes a second factor is recovered with', () => {
  test('is a set as large as the contract says, in the alphabet the contract names', () => {
    const codes = drawnRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of codes) {
      expect(code).toHaveLength(RECOVERY_CODE_LENGTH);
      expect([...code].every((character) => RECOVERY_ALPHABET.includes(character))).toBe(true);
    }
    expect(drawnRecoveryCodes()).not.toEqual(codes);
  });

  test('is kept as a digest and never as the code, and reads the code the way it was shown', () => {
    const [code] = drawnRecoveryCodes();
    const digest = recoveryDigest(code ?? '');
    expect(digest).not.toContain(code ?? '');
    // Shown in groups and typed back with the spacing it was shown in, which is not part of the code.
    expect(recoveryDigest(`${(code ?? '').slice(0, 5)}-${(code ?? '').slice(5)}`.toLowerCase())).toBe(digest);
  });

  test('is compared as two digests of one length, and says no to everything that is not equal', () => {
    const digest = recoveryDigest('AAAAAAAAAA');
    expect(sameDigest(digest, recoveryDigest('AAAAAAAAAA'))).toBe(true);
    expect(sameDigest(digest, recoveryDigest('BBBBBBBBBB'))).toBe(false);
    expect(sameDigest(digest, digest.slice(0, -1))).toBe(false);
  });
});
