// An independent RFC 6238 code generator for the integration test. Written from the RFC rather than
// reused from `src/otp.ts`, so proving the server against a code from here proves it against the
// standard and not against its own arithmetic.

import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const STEP_SECONDS = 30;

const DIGITS = 6;

const symbolValue = (symbol: string): number => {
  const value = ALPHABET.indexOf(symbol.toUpperCase());
  if (value < 0) throw new Error(`authenticatorCode: '${symbol}' is not a base32 symbol`);
  return value;
};

/** RFC 4648 base32 to bytes: five bits accumulated per symbol, a byte taken off once eight are held. */
const base32Decode = (secret: string): Buffer => {
  const bytes: number[] = [];
  let held = 0;
  let bits = 0;
  for (let i = 0; i < secret.length; i += 1) {
    held = (held << 5) | symbolValue(secret.charAt(i));
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((held >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
};

/** RFC 6238's moving factor: whole thirty-second steps since the Unix epoch, as an 8-byte counter. */
const counterAt = (at: Date | number): Buffer => {
  const millis = at instanceof Date ? at.getTime() : at;
  const epochSeconds = Math.floor(millis / 1000);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(epochSeconds / STEP_SECONDS)));
  return counter;
};

/** RFC 4226 section 5.3's dynamic truncation: the low nibble of the last byte picks a 4-byte window. */
const truncate = (mac: Buffer): number => {
  const offset = mac.readUInt8(mac.length - 1) & 0x0f;
  return mac.readUInt32BE(offset) & 0x7f_ff_ff_ff;
};

/** The 6-digit code a base32 secret gives at a moment, per RFC 6238 over HMAC-SHA1. */
export function authenticatorCode(secret: string, at: Date | number): string {
  const mac = createHmac('sha1', base32Decode(secret)).update(counterAt(at)).digest();
  return String(truncate(mac) % 10 ** DIGITS).padStart(DIGITS, '0');
}
