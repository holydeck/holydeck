// The passkey store against a real MongoDB, because what matters here is atomicity the in-memory fake
// cannot prove: the duplicate key a second registration under one credential identifier is refused by,
// and the find-and-delete that lets exactly one of two concurrent spends of the same challenge through.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import {
  CHALLENGE_COLLECTION,
  PASSKEY_COLLECTION,
  PASSKEY_INDEXES,
  PasskeyError,
  createPasskeyIndexOn,
  passkeyContext,
  passkeyDb,
  passkeysOn,
} from './passkeys.js';
import { startTestMongo } from '../test/helpers/mongo.js';

import type { Db } from 'mongodb';
import type { NewPasskey, PasskeyDb, PasskeyStore } from './passkeys.js';
import type { TestMongo } from '../test/helpers/mongo.js';

const START = Date.parse('2026-09-13T09:30:00.000Z');
const ACCOUNT = 'IEalQ4oTp5nH61bKqymC6w';
const GATEKEEPER = passkeyContext('req-9b1f4c02');

const KEY: NewPasskey = {
  id: 'credential-one',
  name: 'a laptop',
  publicKey: 'cHVibGljLWtleQ',
  counter: 0,
  transports: ['internal'],
  synced: true,
};

let mongo: TestMongo;
let live: Db;
let db: PasskeyDb;
let store: PasskeyStore;
let clock: number;

const declareIndexes = async (): Promise<void> => {
  for (const index of PASSKEY_INDEXES) await createPasskeyIndexOn(db, index);
};

beforeAll(async () => {
  mongo = await startTestMongo();
  live = mongo.db;
  db = passkeyDb(live);
}, 120_000);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await live.dropDatabase();
  clock = START;
  store = passkeysOn(db, { now: () => new Date(clock).toISOString() });
});

describe('a passkey in a real database', () => {
  test('the declared indexes build, one per collection, and are listed under their own names', async () => {
    await declareIndexes();

    const keys = await live.collection(PASSKEY_COLLECTION).listIndexes().toArray();
    expect(keys.find((index) => index['name'] === 'passkey_account')).toMatchObject({
      key: { account: 1, registeredAt: -1 },
    });
    const challenges = await live.collection(CHALLENGE_COLLECTION).listIndexes().toArray();
    expect(challenges.find((index) => index['name'] === 'passkey_challenge_expiry')).toMatchObject({
      key: { expiresAt: 1 },
      expireAfterSeconds: 0,
    });
  });

  test('refuses a second registration under one credential identifier by the duplicate key, not a read of its own', async () => {
    await store.register(GATEKEEPER, ACCOUNT, KEY);

    const refused = await store.register(GATEKEEPER, ACCOUNT, { ...KEY, name: 'a phone' }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PasskeyError);
    expect(refused).toMatchObject({ kind: 'duplicate' });
    expect(await live.collection(PASSKEY_COLLECTION).countDocuments({})).toBe(1);
  });

  // Two sign-ins answering the same challenge together is the case `spend` is shaped around: this is the
  // moment a find that ran first would say yes to both. The find-and-delete is what keeps the answer to
  // only one of them.
  test('lets exactly one of two spends of the same challenge through, and refuses the other', async () => {
    const challenge = await store.challenge(GATEKEEPER, 'authentication');

    const [first, second] = await Promise.all([
      store.spend(GATEKEEPER, 'authentication', challenge),
      store.spend(GATEKEEPER, 'authentication', challenge),
    ]);

    expect([first, second].filter((spent) => spent !== undefined)).toHaveLength(1);
    expect(await live.collection(CHALLENGE_COLLECTION).countDocuments({})).toBe(0);
  });

  test('removes a key when revoked, and answers false the second time', async () => {
    await store.register(GATEKEEPER, ACCOUNT, KEY);
    await expect(store.revoke(GATEKEEPER, ACCOUNT, KEY.id)).resolves.toBe(true);
    expect(await live.collection(PASSKEY_COLLECTION).countDocuments({})).toBe(0);
    await expect(store.revoke(GATEKEEPER, ACCOUNT, KEY.id)).resolves.toBe(false);
  });
});
