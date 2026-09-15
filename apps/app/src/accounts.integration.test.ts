// The account store against a real MongoDB, because the one promise it makes is the database's: an
// instance is claimed exactly once however many claims arrive at once, and what refuses the second one is
// a unique index rather than a question this code asked before it wrote. An in-memory collection can
// imitate that refusal; only a real database can be the reason for it.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import {
  ACCOUNTS_COLLECTION,
  ACCOUNT_INDEXES,
  AccountError,
  accountContext,
  accountDb,
  accountPrivileges,
  accountsOn,
  createAccountIndexOn,
  dropAccountIndexOn,
} from './accounts.js';
import { STORED_COST, hashPassword, verifyPassword } from './credentials.js';
import { startRestrictedMongo, startTestMongo } from '../test/helpers/mongo.js';

import type { Db } from 'mongodb';
import type { AccountDb, AccountStore } from './accounts.js';
import type { RestrictedMongo, TestMongo } from '../test/helpers/mongo.js';

const NOW = '2026-09-13T09:30:00.000Z';

const PASSWORD = 'a-long-enough-passphrase';

const CLAIM = { name: 'andru', displayName: 'Andru Tharmarajah', password: PASSWORD };

const FIRST_RUN = accountContext('req-0f9c2a41');

// Derived at a cost of two: what this suite proves is what the database refuses, not what scrypt costs.
const weakly = (password: string): Promise<string> =>
  hashPassword(password, { cost: 2, blockSize: 1, parallelism: 1 });

interface StoredAccount {
  _id: string;
  name?: string;
  role?: string;
  credential?: string;
  founder?: boolean;
}

let mongo: TestMongo;
let live: Db;
let db: AccountDb;
let store: AccountStore;

const accounts = () => live.collection<StoredAccount>(ACCOUNTS_COLLECTION);

const named = (name: string): (typeof ACCOUNT_INDEXES)[number] =>
  ACCOUNT_INDEXES.find((index) => index.name === name) as (typeof ACCOUNT_INDEXES)[number];

/** What a first run asks the database for before it writes anything into the collection. */
const declareIndexes = async (on: AccountDb): Promise<void> => {
  for (const index of ACCOUNT_INDEXES) await createAccountIndexOn(on, index);
};

beforeAll(async () => {
  mongo = await startTestMongo();
  live = mongo.db;
  db = accountDb(live);
}, 120_000);

afterAll(async () => {
  await mongo.stop();
});

beforeEach(async () => {
  await live.dropDatabase();
  store = accountsOn(db, { now: () => NOW, hash: weakly });
});

describe('claiming an instance in a real database', () => {
  test('is refused a second time by the index, whatever handle the second claim asks for', async () => {
    await declareIndexes(db);
    const founder = await store.claim(FIRST_RUN, CLAIM);

    const again = store.claim(FIRST_RUN, { ...CLAIM, name: 'someone-else' });
    await expect(again).rejects.toBeInstanceOf(AccountError);
    await expect(again).rejects.toMatchObject({ kind: 'claimed' });

    // The handle in that second claim is one no row holds, so the only thing that could have refused it is
    // the partial unique index over the founder marker, answering with duplicate key 11000.
    expect(await store.count(FIRST_RUN)).toBe(1);
    expect((await accounts().find({}).toArray()).map((row) => row._id)).toEqual([founder.id]);
  });

  // Two claims arriving together is the case the store is shaped around: this is the moment when asking
  // "has this instance been claimed?" before writing answers "no" to both of them.
  test('lets exactly one of two claims that arrive at once through, and refuses the other', async () => {
    await declareIndexes(db);

    const outcomes = await Promise.allSettled([
      store.claim(FIRST_RUN, CLAIM),
      store.claim(FIRST_RUN, { ...CLAIM, name: 'someone-else' }),
    ]);

    const statuses = outcomes.map((outcome) => outcome.status);
    expect(statuses.filter((status) => status === 'fulfilled')).toHaveLength(1);
    expect(statuses.filter((status) => status === 'rejected')).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toMatchObject({ name: 'AccountError', kind: 'claimed' });
      }
    }
    expect(await store.count(FIRST_RUN)).toBe(1);
  });

  // Every claim writes the founder marker, so with both indexes built either one would refuse a repeated
  // handle and the store would report the same refusal for both. Building only account_name leaves one
  // possible answer, and it is that index's; 'claimed' is what the store calls a duplicate key, because in
  // a collection a claim is the only writer of, a handle taken twice and a founder twice are one event.
  test('refuses a handle another account already holds, on the index that is there for that', async () => {
    await createAccountIndexOn(db, named('account_name'));
    await store.claim(FIRST_RUN, CLAIM);

    await expect(store.claim(FIRST_RUN, { ...CLAIM, displayName: 'Someone Else' })).rejects.toMatchObject({
      name: 'AccountError',
      kind: 'claimed',
    });
    expect(await store.count(FIRST_RUN)).toBe(1);
  });

  test('keeps a credential derived at what a deployment derives at, and the database hands it back whole', async () => {
    // The one test here that pays scrypt's real cost, because a credential is only worth what it was
    // derived at, and surviving a round trip through the driver as written is part of being worth it.
    await declareIndexes(db);
    await accountsOn(db, { now: () => NOW }).claim(FIRST_RUN, CLAIM);

    const [stored] = await accounts().find({}).toArray();
    const derivation = `scrypt$${STORED_COST.cost}$${STORED_COST.blockSize}$${STORED_COST.parallelism}$`;
    expect(stored?.credential?.startsWith(derivation)).toBe(true);
    expect(await verifyPassword(PASSWORD, String(stored?.credential))).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
  });
});

describe('the indexes the collection is claimed through', () => {
  test('are built as declared, and dropping the one that refuses a claim lets a second one through', async () => {
    await declareIndexes(db);
    const built = await accounts().listIndexes().toArray();
    expect(built.find((index) => index.name === 'account_founder')).toMatchObject({
      key: { founder: 1 },
      unique: true,
      partialFilterExpression: { founder: true },
    });

    await store.claim(FIRST_RUN, CLAIM);
    await expect(store.claim(FIRST_RUN, { ...CLAIM, name: 'someone-else' })).rejects.toMatchObject({
      kind: 'claimed',
    });

    await dropAccountIndexOn(db, 'account_founder');
    const left = await accounts().listIndexes().toArray();
    expect(left.map((index) => index.name)).not.toContain('account_founder');
    // The same claim the database refused a moment ago, now accepted: the index was the whole of "claimed
    // exactly once", and nothing this code does would have caught a second founder without it.
    await expect(store.claim(FIRST_RUN, { ...CLAIM, name: 'someone-else' })).resolves.toMatchObject({
      role: 'admin',
    });
    expect(await store.count(FIRST_RUN)).toBe(2);
  });
});

describe('what the database lets this product do to an account', () => {
  let restricted: RestrictedMongo;
  let limited: AccountStore;

  beforeAll(async () => {
    restricted = await startRestrictedMongo(accountPrivileges());
    const granted = accountDb(restricted.db);
    await declareIndexes(granted);
    limited = accountsOn(granted, { now: () => NOW, hash: weakly });
  }, 120_000);

  afterAll(async () => {
    await restricted.stop();
  });

  test('claims an instance with the privileges the store declares, and needs no others to do it', async () => {
    await expect(limited.claim(FIRST_RUN, CLAIM)).resolves.toMatchObject({ name: 'andru', role: 'admin' });
    expect(await limited.claimed(FIRST_RUN)).toBe(true);
    expect(await limited.count(FIRST_RUN)).toBe(1);
  });

  test('can change an account, granting Control presentation needs, but cannot remove one or drop the collection', async () => {
    const collection = restricted.db.collection<StoredAccount>(ACCOUNTS_COLLECTION);
    await expect(collection.updateOne({ founder: true }, { $set: { role: 'member' } })).resolves.toMatchObject({
      modifiedCount: 1,
    });
    const attempts = {
      remove: () => collection.deleteOne({ founder: true }),
      drop: () => collection.drop(),
    };
    for (const [name, attempt] of Object.entries(attempts)) {
      await expect(attempt(), name).rejects.toThrow(/not authorized/u);
    }
    const [stored] = await restricted.root.collection<StoredAccount>(ACCOUNTS_COLLECTION).find({}).toArray();
    expect(stored?.role).toBe('member');
  });
});
