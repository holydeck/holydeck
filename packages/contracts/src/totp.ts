// The second factor, as a client and a server both have to agree it is.
//
// Nothing here holds a secret or checks a code. A shared secret is drawn from the runtime's randomness
// and a code is derived from it by HMAC, and a browser has no business doing either — what travels is
// where a second factor is enrolled, verified, replaced and revoked, the parameters every authenticator
// assumes, the shape a code has after a person has typed it, and the URI a phone reads out of a square.

import { FIELD_CODES, type Parsed, parseObject } from './problems.js';

import type { Bounds } from './accounts.js';

/** Where a second factor is enrolled in and revoked. One resource, and two things that are done to it. */
export const TOTP_PATH = '/api/v1/totp';

/** Where an enrolment proves itself with one code, which is what makes it the account's second factor. */
export const TOTP_VERIFICATION_PATH = `${TOTP_PATH}/verification`;

/** Where a set of recovery codes is replaced by a new one, and every code in the old set stops working. */
export const TOTP_RECOVERY_PATH = `${TOTP_PATH}/recovery`;

/** What RFC 6238 says and every authenticator assumes: six digits, a new one every thirty seconds. */
export const TOTP_DIGITS = 6;

export const TOTP_PERIOD_SECONDS = 30;

/**
 * How many steps either side of now a code is still accepted. One is the clock skew of a phone that has
 * not synchronised today; two would double what a guess is allowed to match against for nothing.
 */
export const TOTP_DRIFT_STEPS = 1;

/** What a person is given for the day the authenticator is lost, and how a set of them is shown. */
export const RECOVERY_CODE_COUNT = 10;

export const RECOVERY_CODE_LENGTH = 10;

export const RECOVERY_CODE_GROUP = 5;

/**
 * Thirty-two characters exactly, so one byte picks one of them by its low five bits and no code is more
 * likely than another. Crockford's alphabet: no I, L, O or U, because a code is read off a screen and
 * typed back by somebody who has just lost their phone.
 */
export const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The ceiling a code is graded against, and the only rule this side applies. A floor would be a rule
 * about what this server issues rather than about what somebody typed, and whether a code is one of
 * theirs is the store's answer to give — it gives one answer to every code that is not.
 */
export const SECOND_FACTOR: Bounds = Object.freeze({ minimum: TOTP_DIGITS, maximum: 64 });

/** What the label in an authenticator reads, and what it names as having issued the secret. */
export const ISSUER = 'HolyDeck';

/**
 * The code as the server looks for it: upper case, and without the spacing it was shown in. A person
 * reading ten characters off a screen types the dash that was there to help them read it, and a code
 * refused for the dash is a code refused for being read correctly.
 */
export const normalizedCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/gu, '');

/** Counted in characters a person typed rather than in the bytes they take, which differ by alphabet. */
const characters = (value: string): number => [...value].length;

export interface SecondFactor {
  readonly code: string;
}

export function parseSecondFactor(value: unknown): Parsed<SecondFactor> {
  return parseObject(value, 'secondFactor', (reader) => {
    const typed = reader.text('code');
    if (characters(typed) > SECOND_FACTOR.maximum) {
      reader.reject('code', FIELD_CODES.notAllowed, `must be at most ${SECOND_FACTOR.maximum} characters`);
    }
    return { code: normalizedCode(typed) };
  });
}

/**
 * What a phone reads out of the square, spelled out rather than left to the defaults: an authenticator
 * that assumes eight digits where this server checks six produces a code that is always wrong, and the
 * person holding it has no way to see why.
 */
export function otpauthUri(enrolment: { readonly secret: string; readonly name: string }): string {
  const label = `${encodeURIComponent(ISSUER)}:${encodeURIComponent(enrolment.name)}`;
  const parameters = new URLSearchParams({
    secret: enrolment.secret,
    issuer: ISSUER,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${parameters.toString()}`;
}
