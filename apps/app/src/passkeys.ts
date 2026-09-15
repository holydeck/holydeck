// Where a passkey is kept, and where the challenge one is answered with is kept until it is answered.
//
// Two collections, for the two lifetimes. A credential is a long-lived thing an account holds and gives
// up deliberately; a challenge is a few bytes that exist for two minutes and are then gone whether they
// were used or not. Keeping them apart means the expiry index that forgets the second can never reach the
// first, and means a deployment can read the size of each without reading the other.
//
// Nothing here verifies a signature or decodes an attestation, the way nothing in `totp.ts` derives a
// code: that is `webauthn.ts`, which is the only file in this application that imports the library. What
// this file owns is the two properties a database has to hold rather than this code — that a credential
// identifier belongs to exactly one key, which is the identifier's own index, and that a challenge is
// answerable exactly once, which is the find-and-delete that spends it.

import { randomBytes } from 'node:crypto';

import { isAccountId } from '@holydeck/contracts/accounts';
import { CHALLENGE_SECONDS, PASSKEY_LIMIT } from '@holydeck/contracts/webauthn';

import { contextProblems, requestContext } from './context.js';

import type { PasskeyTransport } from '@holydeck/contracts/webauthn';
import type { Db } from 'mongodb';

import type { RequestContext } from './context.js';
import type { Document, Filter, ReadOptions } from './repositories.js';

export const PASSKEY_COLLECTION = 'passkey_credentials';

export const CHALLENGE_COLLECTION = 'passkey_challenges';

/** What an actor needs to reach a passkey. Reading is a sign-in's; the rest is a person's own. */
export const PASSKEY_PERMISSIONS = Object.freeze({
  read: 'passkey.read',
  write: 'passkey.write',
} as const);

export type PasskeyNeed = keyof typeof PASSKEY_PERMISSIONS;

/**
 * The database privileges these collections need and no more. The same set covers both, because both are
 * written, read, counted and removed from by this store and by nothing else in the deployment.
 */
export const PASSKEY_ACTIONS: readonly string[] = Object.freeze([
  'createIndex',
  'dropIndex',
  'find',
  'insert',
  'listIndexes',
  'remove',
  'update',
]);

export function passkeyPrivileges(): readonly { readonly collection: string; readonly actions: readonly string[] }[] {
  return Object.freeze([
    { collection: PASSKEY_COLLECTION, actions: PASSKEY_ACTIONS },
    { collection: CHALLENGE_COLLECTION, actions: PASSKEY_ACTIONS },
  ]);
}

export interface PasskeyIndex {
  readonly collection: string;
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

// One index each, and only one. A credential identifier is the document's `_id`, so "one key per
// identifier" is already the database's rule, and what is left to index is the list an account reads.
// A challenge carries a deadline the database is told to enforce, which is what keeps a collection of
// things that live for two minutes from being a collection that grows forever.
const DECLARED_INDEXES: readonly PasskeyIndex[] = [
  { collection: PASSKEY_COLLECTION, name: 'passkey_account', keys: { account: 1, registeredAt: -1 }, options: {} },
  {
    collection: CHALLENGE_COLLECTION,
    name: 'passkey_challenge_expiry',
    keys: { expiresAt: 1 },
    options: { expireAfterSeconds: 0 },
  },
];

export const PASSKEY_INDEXES = Object.freeze(DECLARED_INDEXES);

/** Every field a document carries, so an index can only be declared over something one has. */
const CARRIED: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  [PASSKEY_COLLECTION]: new Set([
    '_id',
    'account',
    'name',
    'publicKey',
    'counter',
    'transports',
    'synced',
    'registeredAt',
    'lastUsedAt',
  ]),
  [CHALLENGE_COLLECTION]: new Set(['_id', 'purpose', 'account', 'issuedAt', 'expiresAt']),
});

/** The two ceremonies a challenge is drawn for. One names the account it is for; the other names nobody. */
export const CHALLENGE_PURPOSES = ['registration', 'authentication'] as const;

export type ChallengePurpose = (typeof CHALLENGE_PURPOSES)[number];

/** Thirty-two bytes of randomness, which is what the specification asks a challenge to be at least. */
const CHALLENGE_BYTES = 32;

export type PasskeyRefusal = 'context' | 'permission' | 'schema' | 'duplicate' | 'limit';

/** Carries why the call was refused, so a caller can tell a defect from a state it asked the wrong thing of. */
export class PasskeyError extends Error {
  readonly kind: PasskeyRefusal;

  constructor(kind: PasskeyRefusal, message: string) {
    super(message);
    this.name = 'PasskeyError';
    this.kind = kind;
  }
}

/** A key as it arrives from a ceremony that has already been verified. */
export interface NewPasskey {
  readonly id: string;
  readonly name: string;
  readonly publicKey: string;
  readonly counter: number;
  readonly transports: readonly PasskeyTransport[];
  /** What the authenticator said about whether the key is backed up, which is whose problem a lost phone is. */
  readonly synced: boolean;
}

/** A key as the store holds it. The public key is in here because a sign-in has to check a signature with it. */
export interface StoredPasskey extends NewPasskey {
  readonly account: string;
  readonly registeredAt: string;
  readonly lastUsedAt?: string;
}

/** What spending a challenge says: which account it was drawn for, if it was drawn for one at all. */
export interface SpentChallenge {
  readonly account?: string;
}

export interface FoundOptions {
  readonly returnDocument: 'after';
  readonly upsert: boolean;
}

/** The slice of a Mongo collection the store uses. Narrow on purpose: a test can supply all of it. */
export interface PasskeyCollection {
  findOne(filter: Filter): Promise<Document | null>;
  find(filter: Filter, options?: ReadOptions): { toArray(): Promise<Document[]> };
  countDocuments(filter: Filter): Promise<number>;
  insertOne(document: Document): Promise<{ insertedId: unknown }>;
  findOneAndDelete(filter: Filter): Promise<Document | null>;
  updateOne(filter: Filter, update: Document): Promise<{ matchedCount: number }>;
  deleteOne(filter: Filter): Promise<{ deletedCount: number }>;
  createIndex(keys: Readonly<Record<string, 1 | -1>>, options?: Readonly<Record<string, unknown>>): Promise<string>;
  dropIndex(index: string): Promise<void>;
}

export interface PasskeyDb {
  collection(name: string): PasskeyCollection;
}

/** Building an index needs no passkey verb, so the call asks for none — the shape sessions uses. */
export interface IndexDb {
  collection(name: string): Pick<PasskeyCollection, 'createIndex' | 'dropIndex'>;
}

/** The context the server reaches its own store under: itself, allowed to read and to write, no more. */
export function passkeyContext(correlationId: string): RequestContext {
  return requestContext({
    actor: 'system',
    permissions: Object.values(PASSKEY_PERMISSIONS),
    correlationId,
  });
}

export interface PasskeyOptions {
  /** Injected, so every deadline one store writes comes from one clock and a test does not have to wait. */
  readonly now: () => string;
}

export interface PasskeyStore {
  /** Draws a challenge, remembers what it is for, and hands it back to be sent to a browser once. */
  challenge(context: unknown, purpose: ChallengePurpose, account?: string): Promise<string>;
  /** Takes a challenge out of the store, which is what makes it answerable exactly once. */
  spend(context: unknown, purpose: ChallengePurpose, challenge: string): Promise<SpentChallenge | undefined>;
  /**
   * Keeps a verified key, refusing one the deployment already holds and one over the account's ceiling,
   * and answers with the row as it was written: the caller needs the moment, and only the clock has it.
   */
  register(context: unknown, account: string, key: NewPasskey): Promise<StoredPasskey>;
  /** Every key the account holds, newest first. */
  list(context: unknown, account: string): Promise<readonly StoredPasskey[]>;
  /** The key an assertion names, whatever account holds it — a passkey sign-in names nobody up front. */
  find(context: unknown, id: string): Promise<StoredPasskey | undefined>;
  /** Records that the key was used, and moves the counter to what the authenticator reported. */
  used(context: unknown, id: string, counter: number): Promise<void>;
  /** Changes what a key is called, and answers whether that account had one by that identifier. */
  rename(context: unknown, account: string, id: string, name: string): Promise<boolean>;
  /** Removes a key, and answers whether there was one to remove. The password is untouched. */
  revoke(context: unknown, account: string, id: string): Promise<boolean>;
}

const after = (instant: string, milliseconds: number): Date => new Date(Date.parse(instant) + milliseconds);

const isDuplicate = (error: unknown): boolean => (error as { code?: unknown }).code === 11_000;

const heldPasskey = (row: Document): StoredPasskey => ({
  id: String(row['_id']),
  account: String(row['account']),
  name: String(row['name']),
  publicKey: String(row['publicKey']),
  counter: Number(row['counter']),
  transports: row['transports'] as readonly PasskeyTransport[],
  synced: row['synced'] === true,
  registeredAt: String(row['registeredAt']),
  ...(row['lastUsedAt'] === undefined ? {} : { lastUsedAt: String(row['lastUsedAt']) }),
});

/** The store over one database. Nothing here reads an ambient clock, database or current user. */
export function passkeysOn(db: PasskeyDb, options: PasskeyOptions): PasskeyStore {
  const keys = (): PasskeyCollection => db.collection(PASSKEY_COLLECTION);

  const pending = (): PasskeyCollection => db.collection(CHALLENGE_COLLECTION);

  /** The two questions every verb asks before it touches a collection. */
  const permit = (context: unknown, need: PasskeyNeed): void => {
    const problems = contextProblems(context);
    if (problems.length > 0) throw new PasskeyError('context', `passkeys: ${problems.join('; ')}`);
    const permission = PASSKEY_PERMISSIONS[need];
    if (!(context as RequestContext).permissions.includes(permission)) {
      throw new PasskeyError('permission', `passkeys: the actor may not ${need} a passkey, which needs ${permission}`);
    }
  };

  const owned = (account: string): void => {
    if (!isAccountId(account)) throw new PasskeyError('schema', 'passkeys: a passkey belongs to one account');
  };

  const store: PasskeyStore = {
    async challenge(context, purpose, account) {
      permit(context, 'write');
      // A registration is asked for by an account that has already proved who it is, and the challenge
      // is remembered against it. A sign-in is asked for by nobody at all, which is the whole point of a
      // discoverable credential: the browser, not this server, decides which account is about to answer.
      if (purpose === 'registration') owned(account ?? '');
      else if (account !== undefined) {
        throw new PasskeyError('schema', 'passkeys: a sign-in challenge is drawn for nobody in particular');
      }
      const challenge = randomBytes(CHALLENGE_BYTES).toString('base64url');
      const now = options.now();
      await pending().insertOne({
        _id: challenge,
        purpose,
        ...(account === undefined ? {} : { account }),
        issuedAt: now,
        expiresAt: after(now, CHALLENGE_SECONDS * 1000),
      });
      return challenge;
    },

    async spend(context, purpose, challenge) {
      permit(context, 'write');
      const row = await pending().findOneAndDelete({ _id: challenge, purpose });
      if (row === null) return undefined;
      // Read against the injected clock rather than trusted to the expiry index: mongod removes a
      // finished document when its background pass next comes round, which is after the deadline and
      // not at it. The row is gone either way, because a challenge this server has read is spent.
      if (Date.parse(String(row['expiresAt'])) <= Date.parse(options.now())) return undefined;
      return { account: row['account'] === undefined ? undefined : String(row['account']) };
    },

    async register(context, account, key) {
      permit(context, 'write');
      owned(account);
      // Counted before the insert rather than held by the database, because a ceiling on how long a list
      // is has nothing to hold against a second request arriving at the same moment. Two registrations
      // landing together can leave an account with one key over the ceiling, and that is all it can do.
      const held = await keys().countDocuments({ account });
      if (held >= PASSKEY_LIMIT) {
        throw new PasskeyError('limit', `passkeys: an account holds at most ${PASSKEY_LIMIT} passkeys`);
      }
      const registeredAt = options.now();
      try {
        await keys().insertOne({
          _id: key.id,
          account,
          name: key.name,
          publicKey: key.publicKey,
          counter: key.counter,
          transports: key.transports,
          synced: key.synced,
          registeredAt,
        });
      } catch (error) {
        if (!isDuplicate(error)) throw error;
        throw new PasskeyError('duplicate', 'passkeys: that key is already registered');
      }
      return { ...key, account, registeredAt };
    },

    async list(context, account) {
      permit(context, 'read');
      owned(account);
      const rows = await keys()
        .find({ account }, { sort: { registeredAt: -1 } })
        .toArray();
      return rows.map(heldPasskey);
    },

    async find(context, id) {
      permit(context, 'read');
      const row = await keys().findOne({ _id: id });
      return row === null ? undefined : heldPasskey(row);
    },

    async used(context, id, counter) {
      permit(context, 'write');
      // Whether the key is still there is not asked: a key revoked between the assertion and this write
      // is a key this server no longer holds, and writing a counter back onto nothing is the right amount
      // of nothing to happen.
      await keys().updateOne({ _id: id }, { $set: { counter, lastUsedAt: options.now() } });
    },

    async rename(context, account, id, name) {
      permit(context, 'write');
      owned(account);
      const { matchedCount } = await keys().updateOne({ _id: id, account }, { $set: { name } });
      return matchedCount > 0;
    },

    async revoke(context, account, id) {
      permit(context, 'write');
      owned(account);
      // The account is in the filter rather than read first and compared, so one write decides it and
      // knowing a key's identifier is not enough to take it away from whoever registered it.
      const { deletedCount } = await keys().deleteOne({ _id: id, account });
      return deletedCount > 0;
    },
  };
  return Object.freeze(store);
}

const declaredIndex = (name: string): PasskeyIndex => {
  const index = PASSKEY_INDEXES.find((candidate) => candidate.name === name);
  if (index === undefined) throw new PasskeyError('schema', `${name} is not an index a passkey declares`);
  return index;
};

export async function createPasskeyIndexOn(db: IndexDb, index: PasskeyIndex): Promise<string> {
  const declared = declaredIndex(index.name);
  for (const field of Object.keys(index.keys)) {
    if (CARRIED[declared.collection]?.has(field) !== true) {
      throw new PasskeyError('schema', `${index.name}: ${declared.collection} carries no field named ${field}`);
    }
  }
  return db.collection(declared.collection).createIndex(index.keys, { name: index.name, ...index.options });
}

export async function dropPasskeyIndexOn(db: IndexDb, name: string): Promise<void> {
  const declared = declaredIndex(name);
  return db.collection(declared.collection).dropIndex(name);
}

/**
 * The driver satisfies this interface in practice; the cast is about the document types the driver
 * reports, and about a find-and-delete answering with a document rather than with one or nothing.
 */
export function passkeyDb(db: Db): PasskeyDb {
  return { collection: (name) => db.collection(name) as unknown as PasskeyCollection };
}
