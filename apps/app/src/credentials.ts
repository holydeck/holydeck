// How a password becomes something a deployment can keep.
//
// What is stored is a key derived from the password, the salt it was derived with, and the cost it was
// derived at — never the password, and never a digest a rainbow table answers. The cost travels with the
// credential rather than being read from this file, so raising it later leaves every credential written
// before it readable, which is what makes raising it possible at all.
//
// scrypt rather than argon2id: argon2id is the first choice everywhere it is available, and in this
// runtime it is a native module a deployment would have to compile. scrypt is in the standard library,
// is memory-hard for the same reason, and OWASP names parameters for it that stand in for argon2id.

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/** The derivation this code writes. Written into every credential, and checked when one is read back. */
export const KDF = 'scrypt';

export const KEY_BYTES = 32;

export const SALT_BYTES = 16;

export interface ScryptCost {
  /** scrypt's N: how much memory and time one derivation costs. A power of two. */
  readonly cost: number;
  /** scrypt's r. */
  readonly blockSize: number;
  /** scrypt's p. */
  readonly parallelism: number;
}

/**
 * What a deployment stores at: the parameters OWASP gives for scrypt, which cost about 32 MB and a
 * fraction of a second per derivation. A test derives at a cost of two instead, and says so where it does.
 */
export const STORED_COST: ScryptCost = Object.freeze({ cost: 32_768, blockSize: 8, parallelism: 3 });

/** Raised rather than returned: a stored credential this code could not have written is a defect. */
export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

/** Node's own ceiling, which every cost this code derives at is allowed at least as much as. */
const DEFAULT_MAXMEM = 32 * 1024 * 1024;

const derive = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keyBytes: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * A password is normalised before it is derived from, on the way in and on the way back: a keyboard
 * decides whether an accent arrives as one character or as a letter and a mark, and a person who typed
 * one password typed one password.
 */
const keyFor = (password: string, salt: Buffer, cost: ScryptCost): Promise<Buffer> =>
  derive(password.normalize('NFKC'), salt, KEY_BYTES, {
    N: cost.cost,
    r: cost.blockSize,
    p: cost.parallelism,
    // Node refuses a derivation that would use more than this, and its default is smaller than the cost
    // above needs, so the ceiling is stated in terms of the cost — never below the default, because a
    // small cost still pays scrypt's fixed overhead and a ceiling under it refuses the derivation.
    maxmem: Math.max(DEFAULT_MAXMEM, 256 * cost.cost * cost.blockSize),
  });

export async function hashPassword(password: string, cost: ScryptCost = STORED_COST): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await keyFor(password, salt, cost);
  return [KDF, cost.cost, cost.blockSize, cost.parallelism, salt.toString('base64url'), key.toString('base64url')]
    .join('$');
}

const PARAMETER = /^[1-9][0-9]{0,6}$/u;

interface StoredCredential {
  readonly cost: ScryptCost;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function credentialFrom(stored: string): StoredCredential {
  const parts = stored.split('$');
  if (parts.length !== 6) {
    throw new CredentialError(`a stored credential is six fields, and this one is ${parts.length}`);
  }
  const [algorithm, cost, blockSize, parallelism, salt, key] = parts as [string, string, string, string, string, string];
  if (algorithm !== KDF) throw new CredentialError(`${algorithm} is not the derivation this code can read`);
  for (const [field, value] of [['cost', cost], ['blockSize', blockSize], ['parallelism', parallelism]] as const) {
    if (!PARAMETER.test(value)) throw new CredentialError(`a stored credential’s ${field} is a number, not ${value}`);
  }
  const decoded = { salt: Buffer.from(salt, 'base64url'), key: Buffer.from(key, 'base64url') };
  for (const [field, value, expected] of [['salt', decoded.salt, SALT_BYTES], ['key', decoded.key, KEY_BYTES]] as const) {
    if (value.length !== expected) {
      throw new CredentialError(`a stored credential’s ${field} is ${expected} bytes, and this one is ${value.length}`);
    }
  }
  return {
    cost: { cost: Number(cost), blockSize: Number(blockSize), parallelism: Number(parallelism) },
    ...decoded,
  };
}

/** Compared over two equal lengths, and in the same time whether they match or not. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const credential = credentialFrom(stored);
  const derived = await keyFor(password, credential.salt, credential.cost);
  return timingSafeEqual(derived, credential.key);
}
