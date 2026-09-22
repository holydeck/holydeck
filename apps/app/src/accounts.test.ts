import { actorFor, isAccountId } from '@holydeck/contracts/accounts';
import { beforeEach, describe, expect, test, vi } from 'vitest';

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

  test('reaches the store under a context that may create, read and update an account, and nothing else', () => {
    expect(FIRST_RUN.actor).toBe('system');
    expect([...FIRST_RUN.permissions].sort()).toEqual(
      [ACCOUNT_PERMISSIONS.create, ACCOUNT_PERMISSIONS.read, ACCOUNT_PERMISSIONS.update].sort(),
    );
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
    expect(Object.keys(account ?? {})).toEqual([
      'id',
      'name',
      'displayName',
      'role',
      'createdAt',
      'controlPresentation',
      'disabled',
    ]);
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

  test('a disabled account is refused even with its own correct password, distinctly from one merely wrong', async () => {
    const claimed = await store.claim(FIRST_RUN, CLAIM);
    await expect(store.authenticate(FIRST_RUN, { name: CLAIM.name, password: PASSWORD })).resolves.toEqual(claimed);
    await store.create(FIRST_RUN, { ...CLAIM, name: 'other-admin', role: 'admin' });
    await store.disable(FIRST_RUN, claimed.id);
    await expect(store.authenticate(FIRST_RUN, { name: CLAIM.name, password: PASSWORD })).resolves.toBeUndefined();
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

describe('listing accounts', () => {
  test('returns every account sorted by name through an inclusion projection', async () => {
    const memory = memoryAccounts();
    const original = memory.db.collection;
    let requested: { projection?: Document; sort?: Document } | undefined;
    memory.db.collection = (name) => {
      const collection = original(name);
      return {
        ...collection,
        find: (filter, options) => {
          requested = options;
          return collection.find(filter, options);
        },
      };
    };
    const accounts = accountsOn(memory.db, { now: () => NOW, hash: weakly });
    await accounts.create(FIRST_RUN, { ...CLAIM, name: 'zara', role: 'member' });
    await accounts.create(FIRST_RUN, { ...CLAIM, name: 'amina', role: 'editor' });

    await expect(accounts.list(FIRST_RUN)).resolves.toMatchObject([{ name: 'amina' }, { name: 'zara' }]);
    expect(requested?.sort).toEqual({ name: 1 });
    expect(requested?.projection).toEqual({
      _id: 1,
      name: 1,
      displayName: 1,
      role: 1,
      createdAt: 1,
      controlPresentation: 1,
      disabled: 1,
    });
    expect(requested?.projection).not.toHaveProperty('credential');
    expect(requested?.projection).not.toHaveProperty('founder');
  });

  test('returns no records from an empty collection', async () => {
    const memory = memoryAccounts();
    const accounts = accountsOn(memory.db, { now: () => NOW, hash: weakly });
    await expect(accounts.list(FIRST_RUN)).resolves.toEqual([]);
  });

  test('requires the read permission', async () => {
    const memory = memoryAccounts();
    const accounts = accountsOn(memory.db, { now: () => NOW, hash: weakly });
    await expect(accounts.list({ actor: 'system', permissions: [], correlationId: 'req-0f9c2a41' })).rejects.toMatchObject({
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

describe('administering Control presentation apart from role', () => {
  test('a fresh claim holds it not at all, admin included', async () => {
    const record = await store.claim(FIRST_RUN, CLAIM);
    expect(record.controlPresentation).toBe(false);
  });

  test('a document written before the flag existed reads back as not holding it, not as a defect', async () => {
    const claimed = await store.claim(FIRST_RUN, CLAIM);
    const [stored] = storedAccounts(rows);
    const legacy = Object.fromEntries(Object.entries(stored ?? {}).filter(([field]) => field !== 'controlPresentation'));
    rows.set(claimed.id, legacy);
    await expect(store.read(FIRST_RUN, claimed.id)).resolves.toMatchObject({ controlPresentation: false });
  });

  test('is granted, and the grant is what a later read answers with too', async () => {
    const claimed = await store.claim(FIRST_RUN, CLAIM);
    await expect(store.grantControl(FIRST_RUN, claimed.id, true)).resolves.toMatchObject({
      id: claimed.id,
      controlPresentation: true,
    });
    await expect(store.read(FIRST_RUN, claimed.id)).resolves.toMatchObject({ controlPresentation: true });
  });

  test('is revoked the same way it is granted', async () => {
    const claimed = await store.claim(FIRST_RUN, CLAIM);
    await store.grantControl(FIRST_RUN, claimed.id, true);
    await expect(store.grantControl(FIRST_RUN, claimed.id, false)).resolves.toMatchObject({
      controlPresentation: false,
    });
  });

  test('answers nothing for an identifier no account holds, which is not a defect', async () => {
    await expect(store.grantControl(FIRST_RUN, 'B'.repeat(22), true)).resolves.toBeUndefined();
  });

  test('a document that vanished between the write and the re-read answers as not found, not as a defect', async () => {
    const memory = memoryAccounts();
    const scoped = accountsOn(memory.db, { now: () => NOW, hash: weakly });
    const claimed = await scoped.claim(FIRST_RUN, CLAIM);
    const vanishing = { collection: (name: string) => ({ ...memory.db.collection(name), findOne: async () => null }) };
    const racy = accountsOn(vanishing, { now: () => NOW, hash: weakly });
    await expect(racy.grantControl(FIRST_RUN, claimed.id, true)).resolves.toBeUndefined();
  });

  test('is a write, and is refused without a context or without the permission to make one', async () => {
    await expect(store.grantControl(undefined, 'B'.repeat(22), true)).rejects.toBeInstanceOf(AccountError);
    const blind = { ...FIRST_RUN, permissions: [ACCOUNT_PERMISSIONS.read] };
    await expect(store.grantControl(blind, 'B'.repeat(22), true)).rejects.toMatchObject({ kind: 'permission' });
  });
});

describe('creating an account beyond the one the founder claims', () => {
  const NEW_ACCOUNT = {
    name: 'priya',
    displayName: 'Priya Nair',
    password: 'another-long-passphrase',
    role: 'editor' as const,
  };

  test('creates an account of the role asked, neither founder nor disabled', async () => {
    const record = await store.create(FIRST_RUN, NEW_ACCOUNT);
    expect(record).toMatchObject({ name: 'priya', displayName: 'Priya Nair', role: 'editor', disabled: false });
    expect(storedAccounts(rows).find((row) => row['_id'] === record.id)).toMatchObject({ founder: false });
  });

  test('keeps a derived credential for the account it creates, the same as claim does', async () => {
    const record = await store.create(FIRST_RUN, NEW_ACCOUNT);
    const stored = storedAccounts(rows).find((row) => row['_id'] === record.id);
    expect(String(stored?.['credential'])).toMatch(/^scrypt\$/u);
  });

  test('refuses a name another created account already holds, as a duplicate rather than a claimed instance', async () => {
    await store.create(FIRST_RUN, NEW_ACCOUNT);
    const again = store.create(FIRST_RUN, { ...NEW_ACCOUNT, displayName: 'Someone Else' });
    await expect(again).rejects.toBeInstanceOf(AccountError);
    await expect(again).rejects.toMatchObject({ kind: 'duplicate' });
    expect(await store.count(FIRST_RUN)).toBe(1);
  });

  test('refuses a name the founder itself already holds', async () => {
    await store.claim(FIRST_RUN, CLAIM);
    await expect(store.create(FIRST_RUN, { ...NEW_ACCOUNT, name: CLAIM.name })).rejects.toMatchObject({
      kind: 'duplicate',
    });
  });

  test('an account it would not read back as an account, before it writes one', async () => {
    await expect(store.create(FIRST_RUN, { ...NEW_ACCOUNT, name: 'Priya' })).rejects.toMatchObject({ kind: 'schema' });
    expect(rows.size).toBe(0);
  });

  test('a failure the database raised for some other reason, which is not a name already taken', async () => {
    const broken = accountsOn(
      { collection: () => ({ ...memoryAccounts().db.collection(ACCOUNTS_COLLECTION), insertOne: () => Promise.reject(new Error('the database is not there')) }) },
      { now: () => NOW, hash: weakly },
    );
    await expect(broken.create(FIRST_RUN, NEW_ACCOUNT)).rejects.toThrow('the database is not there');
  });

  test('is a write, and is refused without a context or without the permission to make one', async () => {
    await expect(store.create(undefined, NEW_ACCOUNT)).rejects.toBeInstanceOf(AccountError);
    const blind = { ...FIRST_RUN, permissions: [ACCOUNT_PERMISSIONS.read] };
    await expect(store.create(blind, NEW_ACCOUNT)).rejects.toMatchObject({ kind: 'permission' });
  });
});

describe('closing an account, and reopening it', () => {
  test('is closed without being deleted or renamed, and a later read carries that', async () => {
    const claimed = await store.claim(FIRST_RUN, CLAIM);
    await store.create(FIRST_RUN, { ...CLAIM, name: 'other-admin', role: 'admin' });
    await expect(store.disable(FIRST_RUN, claimed.id)).resolves.toMatchObject({ id: claimed.id, disabled: true });
    await expect(store.read(FIRST_RUN, claimed.id)).resolves.toMatchObject({
      disabled: true,
      name: claimed.name,
      displayName: claimed.displayName,
    });
  });

  test('is reopened the same way it is closed', async () => {
    const claimed = await store.claim(FIRST_RUN, CLAIM);
    await store.create(FIRST_RUN, { ...CLAIM, name: 'other-admin', role: 'admin' });
    await store.disable(FIRST_RUN, claimed.id);
    await expect(store.restore(FIRST_RUN, claimed.id)).resolves.toMatchObject({ disabled: false });
  });

  test('a document written before the flag existed reads back as not closed, not as a defect', async () => {
    const claimed = await store.claim(FIRST_RUN, CLAIM);
    const [stored] = storedAccounts(rows);
    const legacy = Object.fromEntries(Object.entries(stored ?? {}).filter(([field]) => field !== 'disabled'));
    rows.set(claimed.id, legacy);
    await expect(store.read(FIRST_RUN, claimed.id)).resolves.toMatchObject({ disabled: false });
  });

  test('answers nothing for an identifier no account holds, either way, which is not a defect', async () => {
    await expect(store.disable(FIRST_RUN, 'B'.repeat(22))).resolves.toBeUndefined();
    await expect(store.restore(FIRST_RUN, 'B'.repeat(22))).resolves.toBeUndefined();
  });

  test('is a write, and is refused without a context or without the permission to make one', async () => {
    await expect(store.disable(undefined, 'B'.repeat(22))).rejects.toBeInstanceOf(AccountError);
    const blind = { ...FIRST_RUN, permissions: [ACCOUNT_PERMISSIONS.read] };
    await expect(store.disable(blind, 'B'.repeat(22))).rejects.toMatchObject({ kind: 'permission' });
    await expect(store.restore(blind, 'B'.repeat(22))).rejects.toMatchObject({ kind: 'permission' });
  });
});

describe('reassigning which of the three roles an account holds', () => {
  test('is granted, and a later read answers with the new role', async () => {
    const claimed = await store.claim(FIRST_RUN, CLAIM);
    await store.create(FIRST_RUN, { ...CLAIM, name: 'other-admin', role: 'admin' });
    await expect(store.assignRole(FIRST_RUN, claimed.id, 'member')).resolves.toMatchObject({ role: 'member' });
    await expect(store.read(FIRST_RUN, claimed.id)).resolves.toMatchObject({ role: 'member' });
  });

  test('answers nothing for an identifier no account holds, which is not a defect', async () => {
    await expect(store.assignRole(FIRST_RUN, 'B'.repeat(22), 'editor')).resolves.toBeUndefined();
  });

  test('is a write, and is refused without a context or without the permission to make one', async () => {
    await expect(store.assignRole(undefined, 'B'.repeat(22), 'editor')).rejects.toBeInstanceOf(AccountError);
    const blind = { ...FIRST_RUN, permissions: [ACCOUNT_PERMISSIONS.read] };
    await expect(store.assignRole(blind, 'B'.repeat(22), 'editor')).rejects.toMatchObject({ kind: 'permission' });
  });
});


describe('preserving an enabled administrator', () => {
  test.each(['disable', 'demote'] as const)('refuses to %s the last enabled admin before writing', async (change) => {
    const admin = await store.claim(FIRST_RUN, CLAIM);
    const disabled = await store.create(FIRST_RUN, { ...CLAIM, name: 'disabled-admin', role: 'admin' });
    await store.disable(FIRST_RUN, disabled.id);
    await store.create(FIRST_RUN, { ...CLAIM, name: 'member', role: 'member' });
    const before = JSON.stringify(storedAccounts(rows));
    const mutation = change === 'disable'
      ? store.disable(FIRST_RUN, admin.id)
      : store.assignRole(FIRST_RUN, admin.id, 'member');
    await expect(mutation).rejects.toMatchObject({ kind: 'state', message: 'At least one enabled administrator must remain.' });
    expect(JSON.stringify(storedAccounts(rows))).toBe(before);
  });

  test.each(['disable', 'demote'] as const)('allows %s when a legacy enabled admin remains', async (change) => {
    const admin = await store.claim(FIRST_RUN, CLAIM);
    const legacy = await store.create(FIRST_RUN, { ...CLAIM, name: 'legacy-admin', role: 'admin' });
    const document = { ...rows.get(legacy.id)! };
    delete document['disabled'];
    rows.set(legacy.id, document);
    expect(rows.get(legacy.id)).not.toHaveProperty('disabled');
    const mutation = change === 'disable'
      ? store.disable(FIRST_RUN, admin.id)
      : store.assignRole(FIRST_RUN, admin.id, 'member');
    await expect(mutation).resolves.toMatchObject(change === 'disable' ? { disabled: true } : { role: 'member' });
    await expect(store.read(FIRST_RUN, legacy.id)).resolves.toMatchObject({ role: 'admin', disabled: false });
  });

  test('allows retaining the admin role and changing an already disabled admin', async () => {
    const admin = await store.claim(FIRST_RUN, CLAIM);
    await expect(store.assignRole(FIRST_RUN, admin.id, 'admin')).resolves.toMatchObject({ role: 'admin' });
    const other = await store.create(FIRST_RUN, { ...CLAIM, name: 'other', role: 'admin' });
    await store.disable(FIRST_RUN, other.id);
    await expect(store.disable(FIRST_RUN, other.id)).resolves.toMatchObject({ disabled: true });
    await expect(store.assignRole(FIRST_RUN, other.id, 'member')).resolves.toMatchObject({ role: 'member' });
  });
});


test.each(['disable', 'demote'] as const)('counts enabled admins before the %s write', async (change) => {
  const memory = memoryAccounts();
  const collection = memory.db.collection(ACCOUNTS_COLLECTION);
  const counted = vi.spyOn(collection, 'countDocuments');
  const updated = vi.spyOn(collection, 'updateOne');
  const accounts = accountsOn(memory.db, { now: () => NOW, hash: weakly });
  const admin = await accounts.claim(FIRST_RUN, CLAIM);
  await accounts.create(FIRST_RUN, { ...CLAIM, name: 'other-admin', role: 'admin' });
  if (change === 'disable') await accounts.disable(FIRST_RUN, admin.id);
  else await accounts.assignRole(FIRST_RUN, admin.id, 'member');
  expect(counted).toHaveBeenCalledExactlyOnceWith({ role: 'admin', disabled: { $ne: true } });
  expect(counted.mock.invocationCallOrder[0]).toBeLessThan(updated.mock.invocationCallOrder[0] as number);
});
