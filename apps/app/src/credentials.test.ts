import { describe, expect, test } from 'vitest';

import {
  CredentialError,
  KDF,
  KEY_BYTES,
  SALT_BYTES,
  STORED_COST,
  hashPassword,
  verifyPassword,
} from './credentials.js';

// Every test but the one that proves the deployment's own cost runs at a cost of two, because the cost a
// deployment stores at is chosen to take a tenth of a second and a suite pays it once per hash.
const WEAK = { cost: 2, blockSize: 1, parallelism: 1 } as const;

const PASSWORD = 'a-long-enough-passphrase';

describe('how a password is stored', () => {
  test('is a derived key, a salt and the cost it was derived at — and never the password', async () => {
    const stored = await hashPassword(PASSWORD, WEAK);
    const [algorithm, cost, blockSize, parallelism, salt, key] = stored.split('$');
    expect(algorithm).toBe(KDF);
    expect([cost, blockSize, parallelism]).toEqual(['2', '1', '1']);
    expect(Buffer.from(salt ?? '', 'base64url')).toHaveLength(SALT_BYTES);
    expect(Buffer.from(key ?? '', 'base64url')).toHaveLength(KEY_BYTES);
    expect(stored).not.toContain(PASSWORD);
  });

  test('is a different stored value every time, because the salt is drawn every time', async () => {
    const [first, second] = await Promise.all([hashPassword(PASSWORD, WEAK), hashPassword(PASSWORD, WEAK)]);
    expect(first).not.toBe(second);
    await expect(verifyPassword(PASSWORD, first)).resolves.toBe(true);
    await expect(verifyPassword(PASSWORD, second)).resolves.toBe(true);
  });

  test('is derived at a cost that is the deployment’s to raise and never a caller’s to lower silently', async () => {
    // The parameters OWASP names for scrypt where argon2id is not available. They are asserted rather
    // than commented, so lowering them is a change to this test and to whatever explains it.
    expect(STORED_COST).toEqual({ cost: 32_768, blockSize: 8, parallelism: 3 });
    expect(KEY_BYTES).toBeGreaterThanOrEqual(32);
    expect(SALT_BYTES).toBeGreaterThanOrEqual(16);
    const stored = await hashPassword(PASSWORD);
    expect(stored.startsWith(`${KDF}$${STORED_COST.cost}$`)).toBe(true);
    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(true);
  }, 30_000);
});

describe('how a password is checked', () => {
  test('accepts the password it was given and refuses every other one', async () => {
    const stored = await hashPassword(PASSWORD, WEAK);
    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(true);
    await expect(verifyPassword(`${PASSWORD} `, stored)).resolves.toBe(false);
    await expect(verifyPassword('', stored)).resolves.toBe(false);
  });

  test('accepts the password however the keyboard composed it, because a person typed one password', async () => {
    const stored = await hashPassword('café-passphrase-x', WEAK);
    await expect(verifyPassword('café-passphrase-x', stored)).resolves.toBe(true);
  });

  test('refuses a stored credential this code could not have written, rather than reading it as a miss', async () => {
    const stored = await hashPassword(PASSWORD, WEAK);
    const broken = [
      '',
      stored.split('$').slice(1).join('$'),
      stored.replace(KDF, 'argon2id'),
      stored.replace(`${KDF}$2$`, `${KDF}$two$`),
      `${stored}$extra`,
      stored.slice(0, -4),
    ];
    for (const candidate of broken) {
      await expect(verifyPassword(PASSWORD, candidate)).rejects.toBeInstanceOf(CredentialError);
    }
  });
});
