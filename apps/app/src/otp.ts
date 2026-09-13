// What a second factor is made of: a shared secret, the code it gives at a moment, and the codes that get
// an account back when the phone holding the secret is gone.
//
// Hand-rolled rather than taken from a package. RFC 6238 is an HMAC, a truncation and a modulo over a
// counter of thirty-second steps, and every authenticator agrees on those three because the RFC publishes
// the vectors they are checked against — which this file's tests answer. A dependency here would widen the
// supply chain of every release for thirty lines that the standard library already has the pieces for,
// the same trade `./credentials.js` made when it took scrypt over a native argon2id.
//
// Nothing here reads or writes a record: what a stored second factor looks like is `./totp.js`'s.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  RECOVERY_ALPHABET,
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_LENGTH,
  TOTP_DIGITS,
  TOTP_DRIFT_STEPS,
  TOTP_PERIOD_SECONDS,
  normalizedCode,
} from '@holydeck/contracts/totp';

/** Raised rather than returned: a secret this code could not have written is a defect, not a refusal. */
export class OtpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtpError';
  }
}

/** 160 bits, which is what RFC 4226 asks a shared secret to be and what every authenticator assumes. */
export const SECRET_BYTES = 20;

/** RFC 4648's alphabet, and the one a phone's camera and a person's typing both expect to see. */
export const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const BASE32_GROUP_BYTES = 5;

const BASE32_GROUP_SYMBOLS = 8;

const BASE32 = /^[A-Z2-7]+$/u;

/**
 * Base32 of whole groups only. A secret is drawn at a length that fills them, so the padding the RFC
 * defines for a partial group is a case this deployment never writes — and refusing to write one is
 * cheaper to be sure of than carrying code for a shape that would mean something else had gone wrong.
 */
export function encodedSecret(bytes: Buffer): string {
  if (bytes.length % BASE32_GROUP_BYTES !== 0) {
    throw new OtpError(`a secret is written in groups of ${BASE32_GROUP_BYTES} bytes`);
  }
  let bits = 0;
  let held = 0;
  let encoded = '';
  for (const byte of bytes) {
    held = (held << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += BASE32_ALPHABET.charAt((held >> bits) & 31);
    }
  }
  return encoded;
}

/** The bytes back out of a stored secret. Strict, because the only writer of one is the line above. */
export function decodedSecret(secret: string): Buffer {
  if (!BASE32.test(secret) || secret.length % BASE32_GROUP_SYMBOLS !== 0) {
    throw new OtpError('a stored secret is base32 in whole groups');
  }
  let bits = 0;
  let held = 0;
  const bytes: number[] = [];
  for (const symbol of secret) {
    held = (held << 5) | BASE32_ALPHABET.indexOf(symbol);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((held >> bits) & 255);
    }
  }
  return Buffer.from(bytes);
}

/** A fresh shared secret, drawn from the runtime's randomness and never from anything a caller passed. */
export const drawnSecret = (): string => encodedSecret(randomBytes(SECRET_BYTES));

/**
 * Which thirty-second step a moment falls in. Counted from the epoch with no offset, which is what the
 * RFC's T0 of zero means and what an authenticator that was only ever shown a secret has to assume.
 */
export function stepAt(moment: string): number {
  const milliseconds = Date.parse(moment);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new OtpError(`not a moment: ${moment}`);
  return Math.floor(milliseconds / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code a secret gives at one step: HMAC-SHA1, the RFC's dynamic truncation, and its last digits. */
export function codeAt(secret: string, step: number): string {
  if (!Number.isSafeInteger(step) || step < 0) throw new OtpError(`not a step: ${step}`);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', decodedSecret(secret)).update(counter).digest();
  const offset = mac.readUInt8(mac.length - 1) & 15;
  const truncated = mac.readUInt32BE(offset) & 0x7f_ff_ff_ff;
  return String(truncated % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * Which step a typed code was the code for, if it was the code for one. The step is the answer rather
 * than a yes, because a code that is right is only accepted once and the caller has to know which step to
 * remember. A drift of one step either way is the clock of a phone that has not synchronised today;
 * widening it would double what a guess is allowed to match against for nothing.
 */
export function matchedStep(secret: string, code: string, moment: string, drift = TOTP_DRIFT_STEPS): number | undefined {
  if (code.length !== TOTP_DIGITS) return undefined;
  const typed = Buffer.from(code);
  const now = stepAt(moment);
  for (let step = now - drift; step <= now + drift; step += 1) {
    if (timingSafeEqual(typed, Buffer.from(codeAt(secret, step)))) return step;
  }
  return undefined;
}

/**
 * A fresh set of recovery codes. Drawn one byte per character from an alphabet of thirty-two, which
 * divides two hundred and fifty-six exactly and so takes no modulo that would favour its first letters.
 * The alphabet is the contract's: no letter a digit is mistaken for, because these are read off paper.
 * Two of the ten coming out the same is fifty bits against itself nine times, and the cost of it if it
 * ever happened is one fewer code in that set — which is not worth a check that could never be run.
 */
const drawnRecoveryCode = (): string =>
  [...randomBytes(RECOVERY_CODE_LENGTH)]
    .map((byte) => RECOVERY_ALPHABET.charAt(byte % RECOVERY_ALPHABET.length))
    .join('');

export const drawnRecoveryCodes = (): readonly string[] =>
  Object.freeze(Array.from({ length: RECOVERY_CODE_COUNT }, drawnRecoveryCode));

/**
 * What a recovery code is kept as. A digest and not a derived key: a recovery code is fifty bits this
 * server drew, not a word a person chose, so there is no dictionary for a memory-hard function to make
 * expensive — and a set of ten is rewritten often enough that ten scrypt derivations would be felt.
 */
export const recoveryDigest = (code: string): string =>
  createHash('sha256').update(normalizedCode(code)).digest('base64url');

/** Two digests compared in a time that does not say how far along they stopped being equal. */
export const sameDigest = (held: string, presented: string): boolean => {
  const left = Buffer.from(held);
  const right = Buffer.from(presented);
  return left.length === right.length && timingSafeEqual(left, right);
};
