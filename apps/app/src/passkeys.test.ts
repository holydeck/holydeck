import { PASSKEY_LIMIT } from '@holydeck/contracts/webauthn';
import { beforeEach, describe, expect, test } from 'vitest';

import { requestContext } from './context.js';
import {
  CHALLENGE_COLLECTION,
  PASSKEY_ACTIONS,
  PASSKEY_COLLECTION,
  PASSKEY_INDEXES,
  PASSKEY_PERMISSIONS,
  PasskeyError,
  createPasskeyIndexOn,
  dropPasskeyIndexOn,
  passkeyContext,
  passkeyDb,
  passkeyPrivileges,
  passkeysOn,
} from './passkeys.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';

import type { Db } from 'mongodb';

import type { NewPasskey, PasskeyStore } from './passkeys.js';

const ACCOUNT = '7f3aQmVhdGl0dWRlc19hcmU';
const OTHER = '9b1cU2Vjb25kX2FjY291bnQx';
const CORRELATION = 'req-0f9c2a41';

let clock = Date.parse('2026-09-13T09:30:00.000Z');
let rows: Map<string, Map<string, Record<string, unknown>>>;
let names: string[];
let store: PasskeyStore;
let memory: ReturnType<typeof memoryPasskeys>;

const now = (): string => new Date(clock).toISOString();

const context = (): unknown => passkeyContext(CORRELATION);

const credentials = (): Map<string, Record<string, unknown>> => rows.get(PASSKEY_COLLECTION) ?? new Map();

const challenges = (): Map<string, Record<string, unknown>> => rows.get(CHALLENGE_COLLECTION) ?? new Map();

const key = (id: string, over: Partial<NewPasskey> = {}): NewPasskey => ({
  id,
  name: 'the phone in my pocket',
  publicKey: 'pQECAyYgASFYIA',
  counter: 0,
  transports: ['internal'],
  synced: true,
  ...over,
});

beforeEach(() => {
  clock = Date.parse('2026-09-13T09:30:00.000Z');
  memory = memoryPasskeys();
  rows = memory.rows;
  names = memory.names;
  store = passkeysOn(memory.db, { now });
});

describe('what the passkey store owns', () => {
  test('names the collections it owns, the permissions it is reached through, and the actions it needs', () => {
    expect(PASSKEY_COLLECTION).toBe('passkey_credentials');
    expect(CHALLENGE_COLLECTION).toBe('passkey_challenges');
    expect(PASSKEY_PERMISSIONS).toEqual({ read: 'passkey.read', write: 'passkey.write' });
    expect(passkeyPrivileges()).toEqual([
      { collection: PASSKEY_COLLECTION, actions: PASSKEY_ACTIONS },
      { collection: CHALLENGE_COLLECTION, actions: PASSKEY_ACTIONS },
    ]);
    expect(PASSKEY_ACTIONS).not.toContain('listCollections');
  });

  test('is reached under a context that is the product acting as itself, and under nothing else', async () => {
    await expect(store.register({}, ACCOUNT, key('one'))).rejects.toMatchObject({ kind: 'context' });
    const readOnly = requestContext({
      actor: 'system',
      permissions: [PASSKEY_PERMISSIONS.read],
      correlationId: CORRELATION,
    });
    const refused = await store.register(readOnly, ACCOUNT, key('one')).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PasskeyError);
    expect(refused).toMatchObject({ kind: 'permission' });
    expect(String(refused)).toContain(PASSKEY_PERMISSIONS.write);
  });

  test('is asked for one account, and an identifier no account has is refused before any write', async () => {
    await expect(store.register(context(), 'not an identifier', key('one'))).rejects.toMatchObject({ kind: 'schema' });
    await expect(store.list(context(), 'not an identifier')).rejects.toMatchObject({ kind: 'schema' });
    expect(credentials().size).toBe(0);
  });

  test('touches its own two collections and no other, so revoking a key cannot reach a password', async () => {
    await store.register(context(), ACCOUNT, key('one'));
    await store.challenge(context(), 'authentication');
    await store.revoke(context(), ACCOUNT, 'one');
    expect(new Set(names)).toEqual(new Set([PASSKEY_COLLECTION, CHALLENGE_COLLECTION]));
  });
});

describe('drawing a challenge, which is the half of a ceremony this server owns', () => {
  test('draws one nobody chose, remembers what it is for, and hands it back once', async () => {
    const challenge = await store.challenge(context(), 'authentication');
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(challenges().get(challenge)).toMatchObject({ purpose: 'authentication', issuedAt: now() });
    expect(await store.challenge(context(), 'authentication')).not.toBe(challenge);
  });

  test('a registration challenge is drawn for one account, and an authentication challenge for nobody', async () => {
    const registration = await store.challenge(context(), 'registration', ACCOUNT);
    expect(challenges().get(registration)).toMatchObject({ purpose: 'registration', account: ACCOUNT });
    const authentication = await store.challenge(context(), 'authentication');
    expect(challenges().get(authentication)?.['account']).toBeUndefined();
  });

  test('is refused when a registration names no account, and when a sign-in names one', async () => {
    await expect(store.challenge(context(), 'registration')).rejects.toMatchObject({ kind: 'schema' });
    await expect(store.challenge(context(), 'authentication', ACCOUNT)).rejects.toMatchObject({ kind: 'schema' });
    expect(challenges().size).toBe(0);
  });

  test('stops being worth answering two minutes after it was drawn, and says so to the database', async () => {
    const challenge = await store.challenge(context(), 'authentication');
    expect(challenges().get(challenge)?.['expiresAt']).toEqual(new Date(clock + 120_000));
  });
});

describe('spending a challenge, which is what makes one answerable exactly once', () => {
  test('answers with what it was drawn for, and is gone from the store afterwards', async () => {
    const challenge = await store.challenge(context(), 'registration', ACCOUNT);
    expect(await store.spend(context(), 'registration', challenge)).toEqual({ account: ACCOUNT });
    expect(challenges().size).toBe(0);
  });

  test('a second request presenting the same challenge is answered with nothing', async () => {
    const challenge = await store.challenge(context(), 'authentication');
    expect(await store.spend(context(), 'authentication', challenge)).toEqual({ account: undefined });
    expect(await store.spend(context(), 'authentication', challenge)).toBeUndefined();
  });

  test('a challenge drawn for the other ceremony is not this one’s to spend', async () => {
    const challenge = await store.challenge(context(), 'registration', ACCOUNT);
    expect(await store.spend(context(), 'authentication', challenge)).toBeUndefined();
    expect(challenges().size).toBe(1);
  });

  test('one this server never drew is answered with nothing rather than looked for twice', async () => {
    expect(await store.spend(context(), 'authentication', 'a challenge nobody issued')).toBeUndefined();
  });

  // Read against the injected clock rather than trusted to the expiry index: mongod removes a finished
  // document when its background pass next comes round, which is after the deadline and not at it.
  test('one that has run out is refused by this code, whatever the database has got round to', async () => {
    const challenge = await store.challenge(context(), 'authentication');
    clock += 121_000;
    expect(await store.spend(context(), 'authentication', challenge)).toBeUndefined();
    expect(challenges().size).toBe(0);
  });
});

describe('keeping a key', () => {
  test('holds what an assertion will be checked against, and when it arrived', async () => {
    await store.register(context(), ACCOUNT, key('one'));
    expect(credentials().get('one')).toMatchObject({
      account: ACCOUNT,
      name: 'the phone in my pocket',
      publicKey: 'pQECAyYgASFYIA',
      counter: 0,
      transports: ['internal'],
      synced: true,
      registeredAt: now(),
    });
  });

  test('a key this server already holds is refused, and the database is what refuses it', async () => {
    await store.register(context(), ACCOUNT, key('one'));
    const refused = await store.register(context(), OTHER, key('one')).catch((error: unknown) => error);
    expect(refused).toMatchObject({ kind: 'duplicate' });
    expect(credentials().get('one')).toMatchObject({ account: ACCOUNT });
  });

  test('is a defect when the database refused for any other reason, which is not a passkey’s answer', async () => {
    memory.beforeWrite = () => {
      throw new TypeError('the driver fell over');
    };
    await expect(store.register(context(), ACCOUNT, key('one'))).rejects.toBeInstanceOf(TypeError);
  });

  test('an account keeps a bounded number of them, and the one over the bound is refused', async () => {
    for (let index = 0; index < PASSKEY_LIMIT; index += 1) {
      await store.register(context(), ACCOUNT, key(`key-${index}`));
    }
    const refused = await store.register(context(), ACCOUNT, key('one-too-many')).catch((error: unknown) => error);
    expect(refused).toMatchObject({ kind: 'limit' });
    expect(credentials().size).toBe(PASSKEY_LIMIT);
    // The bound is the account's, not the deployment's: another account is nowhere near it.
    await expect(store.register(context(), OTHER, key('theirs'))).resolves.toMatchObject({
      id: 'theirs',
      account: OTHER,
      registeredAt: now(),
    });
  });
});

describe('reading the keys an account holds', () => {
  test('lists that account’s and nobody else’s, newest first', async () => {
    await store.register(context(), ACCOUNT, key('older', { name: 'the laptop' }));
    clock += 60_000;
    await store.register(context(), ACCOUNT, key('newer', { name: 'the phone' }));
    await store.register(context(), OTHER, key('theirs'));
    expect((await store.list(context(), ACCOUNT)).map((held) => held.name)).toEqual(['the phone', 'the laptop']);
  });

  test('an account holding none is answered with none rather than refused', async () => {
    expect(await store.list(context(), ACCOUNT)).toEqual([]);
  });

  test('a key is found by the identifier an assertion names, whatever account it turns out to be', async () => {
    await store.register(context(), ACCOUNT, key('one'));
    const found = await store.find(context(), 'one');
    expect(found).toMatchObject({ id: 'one', account: ACCOUNT, counter: 0, publicKey: 'pQECAyYgASFYIA' });
    expect(found?.lastUsedAt).toBeUndefined();
    expect(await store.find(context(), 'a key nobody registered')).toBeUndefined();
  });

  test('reading is reached with the read permission alone, because a sign-in has no other', async () => {
    const readOnly = requestContext({
      actor: 'system',
      permissions: [PASSKEY_PERMISSIONS.read],
      correlationId: CORRELATION,
    });
    await store.register(context(), ACCOUNT, key('one'));
    await expect(store.find(readOnly, 'one')).resolves.toMatchObject({ id: 'one' });
    await expect(store.list(readOnly, ACCOUNT)).resolves.toHaveLength(1);
  });
});

describe('what happens to a key after it is used, renamed or given up', () => {
  test('using one moves the counter the authenticator reported, and says when it was last used', async () => {
    await store.register(context(), ACCOUNT, key('one'));
    clock += 60_000;
    await store.used(context(), 'one', 7);
    expect(await store.find(context(), 'one')).toMatchObject({ counter: 7, lastUsedAt: now() });
  });

  test('using one this server no longer holds changes nothing, because revoking it got there first', async () => {
    await expect(store.used(context(), 'one', 7)).resolves.toBeUndefined();
    expect(credentials().size).toBe(0);
  });

  test('renaming one changes what it is called and nothing else about it', async () => {
    await store.register(context(), ACCOUNT, key('one'));
    expect(await store.rename(context(), ACCOUNT, 'one', 'the spare')).toBe(true);
    expect(await store.find(context(), 'one')).toMatchObject({ name: 'the spare', publicKey: 'pQECAyYgASFYIA' });
  });

  test('giving one up removes it, and answers whether there was one to remove', async () => {
    await store.register(context(), ACCOUNT, key('one'));
    expect(await store.revoke(context(), ACCOUNT, 'one')).toBe(true);
    expect(await store.revoke(context(), ACCOUNT, 'one')).toBe(false);
    expect(credentials().size).toBe(0);
  });

  // The account is in the filter rather than read first and compared: one write decides it, so a key
  // cannot be renamed or revoked by somebody who knows its identifier and holds another account.
  test('neither renaming nor revoking reaches another account’s key, and neither says it is there', async () => {
    await store.register(context(), ACCOUNT, key('one'));
    expect(await store.rename(context(), OTHER, 'one', 'mine now')).toBe(false);
    expect(await store.revoke(context(), OTHER, 'one')).toBe(false);
    expect(await store.find(context(), 'one')).toMatchObject({ account: ACCOUNT, name: 'the phone in my pocket' });
  });
});

describe('the indexes a passkey is found by', () => {
  test('declares one for the account a key belongs to and one for the challenge that ran out', () => {
    expect(PASSKEY_INDEXES).toEqual([
      {
        collection: PASSKEY_COLLECTION,
        name: 'passkey_account',
        keys: { account: 1, registeredAt: -1 },
        options: {},
      },
      {
        collection: CHALLENGE_COLLECTION,
        name: 'passkey_challenge_expiry',
        keys: { expiresAt: 1 },
        options: { expireAfterSeconds: 0 },
      },
    ]);
  });

  test('builds and drops the ones it declares, on the collection each one is declared over', async () => {
    for (const index of PASSKEY_INDEXES) {
      await expect(createPasskeyIndexOn(memory.db, index)).resolves.toBe('created');
      await expect(dropPasskeyIndexOn(memory.db, index.name)).resolves.toBeUndefined();
    }
  });

  test('refuses an index nothing declares, and one over a field a document does not carry', async () => {
    const invented = { collection: PASSKEY_COLLECTION, name: 'passkey_invented', keys: { account: 1 }, options: {} };
    await expect(createPasskeyIndexOn(memory.db, invented as never)).rejects.toMatchObject({ kind: 'schema' });
    await expect(dropPasskeyIndexOn(memory.db, 'passkey_invented')).rejects.toMatchObject({ kind: 'schema' });
    const stray = { ...PASSKEY_INDEXES[0], keys: { colour: 1 } } as never;
    await expect(createPasskeyIndexOn(memory.db, stray)).rejects.toMatchObject({ kind: 'schema' });
  });

  test('the driver’s database satisfies the narrow shape the store asks for', () => {
    const collections: string[] = [];
    const db = { collection: (name: string) => collections.push(name) } as unknown as Db;
    passkeyDb(db).collection(PASSKEY_COLLECTION);
    expect(collections).toEqual([PASSKEY_COLLECTION]);
  });
});
