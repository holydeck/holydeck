import { actorFor, isAccountId } from '@holydeck/contracts/accounts';
import { beforeEach, describe, expect, test } from 'vitest';

import {
  ACCOUNTS_COLLECTION,
  ACCOUNT_INDEXES,
  ACCOUNT_PERMISSIONS,
  AccountError,
  accountContext,
  accountPrivileges,
  accountsOn,
  createAccountIndexOn,
  dropAccountIndexOn,
} from './accounts.js';
import { ContextError } from './context.js';
import { hashPassword, verifyPassword } from './credentials.js';
import { memoryAccounts, storedAccounts } from '../test/helpers/accounts.js';

import type { AccountStore } from './accounts.js';
import type { Document } from './repositories.js';

const NOW = '2026-09-13T09:30:00.000Z';

const PASSWORD = 'a-long-enough-passphrase';

const CLAIM = { name: 'andru', displayName: 'Andru Tharmarajah', password: PASSWORD };

const FIRST_RUN = accountContext('req-0f9c2a41');

// Derived at a cost of two: what this suite proves is what the store keeps, not what scrypt costs.
const weakly = (password: string): Promise<string> =>
  hashPassword(password, { cost: 2, blockSize: 1, parallelism: 1 });

let rows: Map<string, Document>;
let names: string[];
let store: AccountStore;

beforeEach(() => {
  const memory = memoryAccounts();
  rows = memory.rows;
  names = memory.names;
  store = accountsOn(memory.db, { now: () => NOW, hash: weakly });
});

describe('claiming a fresh instance', () => {
  test('creates exactly one Admin, and no other account', async () => {
    const record = await store.claim(FIRST_RUN, CLAIM);
    expect(record).toMatchObject({ name: 'andru', displayName: 'Andru Tharmarajah', role: 'admin', createdAt: NOW });
    expect(await store.count(FIRST_RUN)).toBe(1);
    expect(storedAccounts(rows).map((row) => row['role'])).toEqual(['admin']);
    expect(names).toContain(ACCOUNTS_COLLECTION);
  });

  test('gives the account an identifier nobody guesses, which is not the handle they chose', async () => {
    const record = await store.claim(FIRST_RUN, CLAIM);
    expect(isAccountId(record.id)).toBe(true);
    expect(record.id).not.toBe(record.name);
    // What durable history will carry, so an account is followed through the records by one name.
    expect(actorFor(record.id)).toContain(record.id);
  });

  test('keeps a derived credential, and nowhere in what it keeps is the password', async () => {
    await store.claim(FIRST_RUN, CLAIM);
    const [stored] = storedAccounts(rows);
    expect(String(stored?.['credential'])).toMatch(/^scrypt\$/u);
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
  });

  test('marks the account as the one that claimed the instance, which is what closes onboarding', async () => {
    await store.claim(FIRST_RUN, CLAIM);
    expect(storedAccounts(rows).map((row) => row['founder'])).toEqual([true]);
    expect(await store.claimed(FIRST_RUN)).toBe(true);
  });

  test('says the instance is unclaimed until one claim has been made', async () => {
    expect(await store.claimed(FIRST_RUN)).toBe(false);
    expect(await store.count(FIRST_RUN)).toBe(0);
  });
});

describe('claiming an instance that is already claimed', () => {
  test('is refused, whatever handle it asks for, and leaves the one account alone', async () => {
    const first = await store.claim(FIRST_RUN, CLAIM);
    const second = store.claim(FIRST_RUN, { ...CLAIM, name: 'someone-else' });
    await expect(second).rejects.toBeInstanceOf(AccountError);
    await expect(second).rejects.toMatchObject({ kind: 'claimed' });
    expect(await store.count(FIRST_RUN)).toBe(1);
    expect(storedAccounts(rows)[0]?.['_id']).toBe(first.id);
  });

  test('is refused by the write rather than by a question asked before it', async () => {
    // Two claims arriving at once is exactly when asking "has this been claimed?" first lets both in, so
    // the store is handed a collection that refuses the question. Only the write may decide this.
    const memory = memoryAccounts();
    const unasked = {
      collection: (name: string) => ({
        ...memory.db.collection(name),
        countDocuments: () => Promise.reject(new Error('a claim may not ask whether it is the first')),
      }),
    };
    const counting = accountsOn(unasked, { now: () => NOW, hash: weakly });
    await expect(counting.claim(FIRST_RUN, CLAIM)).resolves.toMatchObject({ role: 'admin' });
    await expect(counting.claim(FIRST_RUN, { ...CLAIM, name: 'someone-else' })).rejects.toMatchObject({
      kind: 'claimed',
    });
  });
});

describe('what the store refuses whoever asks', () => {
  test('a call carrying no context at all, rather than acting as nobody', async () => {
    await expect(store.claim(undefined, CLAIM)).rejects.toMatchObject({ kind: 'context' });
    await expect(store.claimed(undefined)).rejects.toMatchObject({ kind: 'context' });
    await expect(store.count(undefined)).rejects.toMatchObject({ kind: 'context' });
  });

  test('a call by an actor the permission it needs was never granted to', async () => {
    const reader = { actor: 'system', permissions: [ACCOUNT_PERMISSIONS.read], correlationId: 'req-0f9c2a41' };
    const creator = { actor: 'system', permissions: [ACCOUNT_PERMISSIONS.create], correlationId: 'req-0f9c2a41' };
    await expect(store.claim(reader, CLAIM)).rejects.toMatchObject({ kind: 'permission' });
    await expect(store.claimed(creator)).rejects.toMatchObject({ kind: 'permission' });
    await expect(store.count(creator)).rejects.toMatchObject({ kind: 'permission' });
  });

  test('a claim it would not read back as an account, before it writes one', async () => {
    await expect(store.claim(FIRST_RUN, { ...CLAIM, name: 'Andru' })).rejects.toMatchObject({ kind: 'schema' });
    expect(rows.size).toBe(0);
  });

  test('a failure the database raised for some other reason, which is not a claim being refused', async () => {
    const broken = accountsOn(
      { collection: () => ({ ...memoryAccounts().db.collection(ACCOUNTS_COLLECTION), insertOne: () => Promise.reject(new Error('the database is not there')) }) },
      { now: () => NOW, hash: weakly },
    );
    await expect(broken.claim(FIRST_RUN, CLAIM)).rejects.toThrow('the database is not there');
  });
});

describe('what the collection is read and written through', () => {
  test('declares a handle no two accounts share and a founder there is only ever one of', () => {
    expect(ACCOUNT_INDEXES.map((index) => index.name)).toEqual(['account_name', 'account_founder']);
    expect(ACCOUNT_INDEXES.map((index) => index.options)).toEqual([
      { unique: true },
      { unique: true, partialFilterExpression: { founder: true } },
    ]);
  });

  test('declares the database privileges the collection needs, and no way to remove an account', () => {
    const privileges = accountPrivileges();
    expect(privileges.collection).toBe(ACCOUNTS_COLLECTION);
    expect(privileges.actions).toContain('insert');
    expect(privileges.actions).not.toContain('remove');
  });

  test('builds an index it declares, and refuses one it does not', async () => {
    const memory = memoryAccounts();
    await expect(createAccountIndexOn(memory.db, ACCOUNT_INDEXES[0]!)).resolves.toBe('created');
    await expect(
      createAccountIndexOn(memory.db, { name: 'account_email', keys: { name: 1 }, options: {} }),
    ).rejects.toMatchObject({ kind: 'schema' });
    await expect(
      createAccountIndexOn(memory.db, { name: 'account_name', keys: { email: 1 }, options: {} }),
    ).rejects.toMatchObject({ kind: 'schema' });
  });

  test('drops an index it declares, and refuses to drop one it does not', async () => {
    const memory = memoryAccounts();
    await expect(dropAccountIndexOn(memory.db, 'account_founder')).resolves.toBeUndefined();
    await expect(dropAccountIndexOn(memory.db, 'account_email')).rejects.toMatchObject({ kind: 'schema' });
  });

  test('reaches the store under a context that may create and read an account, and nothing else', () => {
    expect(FIRST_RUN.actor).toBe('system');
    expect([...FIRST_RUN.permissions].sort()).toEqual([ACCOUNT_PERMISSIONS.create, ACCOUNT_PERMISSIONS.read].sort());
    expect(() => accountContext('no')).toThrow(ContextError);
  });
});

describe('signing in', () => {
  let derived: string[];
  let measured: { password: string; stored: string }[];

  beforeEach(() => {
    derived = [];
    measured = [];
    const memory = memoryAccounts();
    rows = memory.rows;
    store = accountsOn(memory.db, {
      now: () => NOW,
      hash: async (password) => {
        derived.push(password);
        return weakly(password);
      },
      verify: async (password, stored) => {
        measured.push({ password, stored });
        return verifyPassword(password, stored);
      },
    });
  });

  test('the account a handle and its own password belong to is the account the store answers with', async () => {
    const claimed = await store.claim(FIRST_RUN, CLAIM);
    await expect(store.authenticate(FIRST_RUN, { name: CLAIM.name, password: PASSWORD })).resolves.toEqual(claimed);
  });

  test('the answer carries what a client may read, and neither the credential nor the founder marker', async () => {
    await store.claim(FIRST_RUN, CLAIM);
    const account = await store.authenticate(FIRST_RUN, { name: CLAIM.name, password: PASSWORD });
    expect(Object.keys(account ?? {})).toEqual(['id', 'name', 'displayName', 'role', 'createdAt']);
  });

  test('a password that is not that account’s and a handle nobody holds are the same answer', async () => {
    await store.claim(FIRST_RUN, CLAIM);
    const wrong = await store.authenticate(FIRST_RUN, { name: CLAIM.name, password: 'not-the-passphrase' });
    const nobody = await store.authenticate(FIRST_RUN, { name: 'nobody', password: PASSWORD });
    expect(wrong).toBeUndefined();
    expect(nobody).toEqual(wrong);
  });

  // The stopwatch belongs in the integration suite, where the cost is the real one. What is asserted here
  // is the mechanism it would measure: a handle nobody holds is answered by deriving against a credential
  // no password matches, so the work a miss does is the work a hit does.
  test('a handle nobody holds is still measured against a credential, so a miss costs what a hit costs', async () => {
    await store.claim(FIRST_RUN, CLAIM);
    const stored = String(storedAccounts(rows)[0]?.['credential']);
    measured.length = 0;
    await store.authenticate(FIRST_RUN, { name: 'nobody', password: PASSWORD });
    expect(measured).toHaveLength(1);
    expect(measured[0]?.password).toBe(PASSWORD);
    expect(measured[0]?.stored).not.toBe(stored);
  });

  test('the credential a miss is measured against is derived once and kept, not derived per attempt', async () => {
    await store.claim(FIRST_RUN, CLAIM);
    derived.length = 0;
    await store.authenticate(FIRST_RUN, { name: 'nobody', password: PASSWORD });
    await store.authenticate(FIRST_RUN, { name: 'somebody-else', password: PASSWORD });
    expect(derived).toHaveLength(1);
    expect(derived[0]).not.toBe(PASSWORD);
    expect(measured[0]?.stored).toBe(measured[1]?.stored);
  });

  test('a document this store cannot read back is a defect of the server’s, not a refused sign-in', async () => {
    await store.claim(FIRST_RUN, CLAIM);
    const [stored] = storedAccounts(rows);
    rows.set(String(stored?.['_id']), { ...stored, role: 'archbishop' });
    await expect(store.authenticate(FIRST_RUN, { name: CLAIM.name, password: PASSWORD })).rejects.toMatchObject({
      kind: 'schema',
    });
  });

  test('signing in reads an account, and is refused without a context or without the permission to', async () => {
    await expect(store.authenticate(undefined, { name: CLAIM.name, password: PASSWORD })).rejects.toBeInstanceOf(
      AccountError,
    );
    const blind = { ...FIRST_RUN, permissions: [ACCOUNT_PERMISSIONS.create] };
    await expect(store.authenticate(blind, { name: CLAIM.name, password: PASSWORD })).rejects.toMatchObject({
      kind: 'permission',
    });
  });
});

describe('reading an account back by the identifier history carries', () => {
  test('answers the record and never the credential it is kept next to', async () => {
    const claimed = await store.claim(FIRST_RUN, CLAIM);
    const found = await store.read(FIRST_RUN, claimed.id);
    expect(found).toEqual(claimed);
    expect(JSON.stringify(found)).not.toContain('credential');
  });

  test('answers nothing for an identifier no account holds, which is not a defect', async () => {
    await expect(store.read(FIRST_RUN, 'B'.repeat(22))).resolves.toBeUndefined();
  });

  test('a document this store cannot read back is a defect here too, and not an account that is missing', async () => {
    const claimed = await store.claim(FIRST_RUN, CLAIM);
    const [stored] = storedAccounts(rows);
    rows.set(claimed.id, { ...stored, role: 'archbishop' });
    await expect(store.read(FIRST_RUN, claimed.id)).rejects.toMatchObject({ kind: 'schema' });
  });

  test('is a read, and is refused without a context or without the permission to make one', async () => {
    await expect(store.read(undefined, 'B'.repeat(22))).rejects.toBeInstanceOf(AccountError);
    const blind = { ...FIRST_RUN, permissions: [ACCOUNT_PERMISSIONS.create] };
    await expect(store.read(blind, 'B'.repeat(22))).rejects.toMatchObject({ kind: 'permission' });
  });
});
