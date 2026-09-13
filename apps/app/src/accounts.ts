// Where an account lives: its handle, the name it is shown under, what it may do, and the derived
// credential it proves itself with. One collection of its own, for the reason the sessions and the queue
// have theirs — an account is changed over its life (renamed, promoted, given a new password), and the
// durable record classes in records.ts have no verb for changing anything, on purpose.
//
// The one promise this module makes is the one a first run depends on: an instance is claimed exactly
// once. It is kept by a unique index the database enforces rather than by a question this code asks
// before it writes, because two claims arriving together is precisely when that question answers "no"
// twice. The write is the decision; a refusal from it is what "already claimed" means.

import { ACCOUNT_ID_BYTES, actorFor, parseAccountRecord } from '@holydeck/contracts/accounts';
import { randomBytes } from 'node:crypto';

import { contextProblems, requestContext } from './context.js';
import { hashPassword, verifyPassword } from './credentials.js';

import type { AccountRecord, InstanceClaim, SignIn } from '@holydeck/contracts/accounts';
import type { Db } from 'mongodb';

import type { RequestContext } from './context.js';
import type { Document, Filter } from './repositories.js';

export const ACCOUNTS_COLLECTION = 'accounts';

/** What an actor needs to reach the store. Creating an account is administration's; reading is anyone's. */
export const ACCOUNT_PERMISSIONS = Object.freeze({
  create: 'accounts.create',
  read: 'accounts.read',
} as const);

export type AccountNeed = keyof typeof ACCOUNT_PERMISSIONS;

/**
 * The database privileges this collection needs. No `remove`: an account is closed by being written
 * differently, never by disappearing, and a deployment granting exactly this makes that the database's
 * rule. `update` is not here either until something updates one, which is the release that adds it.
 */
export const ACCOUNT_ACTIONS: readonly string[] = Object.freeze([
  'createIndex',
  'dropIndex',
  'find',
  'insert',
  'listIndexes',
]);

export function accountPrivileges(): { readonly collection: string; readonly actions: readonly string[] } {
  return { collection: ACCOUNTS_COLLECTION, actions: ACCOUNT_ACTIONS };
}

export interface AccountIndex {
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

// The second index is the whole of "an instance is claimed once": unique over a field only the founder
// carries, so a second founder is a duplicate key and every other account is outside the index entirely.
const DECLARED_INDEXES: readonly AccountIndex[] = [
  { name: 'account_name', keys: { name: 1 }, options: { unique: true } },
  { name: 'account_founder', keys: { founder: 1 }, options: { unique: true, partialFilterExpression: { founder: true } } },
];

export const ACCOUNT_INDEXES = Object.freeze(DECLARED_INDEXES);

/** Every field the collection holds: an account as a client reads it, and what the store keeps beside it. */
const CARRIED = new Set<string>(['id', 'name', 'displayName', 'role', 'createdAt', '_id', 'credential', 'founder']);

export type AccountRefusal = 'context' | 'permission' | 'schema' | 'claimed';

/** Carries why the call was refused, so a caller can tell a defect from an instance already claimed. */
export class AccountError extends Error {
  readonly kind: AccountRefusal;

  constructor(kind: AccountRefusal, message: string) {
    super(message);
    this.name = 'AccountError';
    this.kind = kind;
  }
}

/** The slice of a Mongo collection the store uses. Narrow on purpose: a test can supply all of it. */
export interface AccountCollection {
  insertOne(document: Document): Promise<{ insertedId: unknown }>;
  findOne(filter: Filter): Promise<Document | null>;
  countDocuments(filter: Filter): Promise<number>;
  createIndex(keys: Readonly<Record<string, 1 | -1>>, options?: Readonly<Record<string, unknown>>): Promise<string>;
  dropIndex(index: string): Promise<void>;
}

export interface AccountDb {
  collection(name: string): AccountCollection;
}

/** Building an index needs no account verb, so the call asks for none — the shape sessions uses. */
export interface IndexDb {
  collection(name: string): Pick<AccountCollection, 'createIndex' | 'dropIndex'>;
}

/** The context the server reaches its own account store under: itself, allowed to create and to read. */
export function accountContext(correlationId: string): RequestContext {
  return requestContext({
    actor: 'system',
    permissions: Object.values(ACCOUNT_PERMISSIONS),
    correlationId,
  });
}

const DUPLICATE_KEY = 11_000;

/**
 * The password the credential a miss is measured against is derived from. It is not a secret and guarding
 * it would buy nothing: no account can hold it, because no handle is attached to it and the derivation it
 * feeds is thrown away against every wrong answer this store gives.
 */
const DECOY = 'no account holds this password';

export interface AccountOptions {
  /** Injected, so every instant one store writes comes from one clock and a test does not wait. */
  readonly now: () => string;
  readonly newId?: () => string;
  /** Injected for the same reason: a suite proves what is stored without paying what scrypt costs. */
  readonly hash?: (password: string) => Promise<string>;
  /** Injected so a suite can assert that a miss was measured, which a stopwatch can only approximate. */
  readonly verify?: (password: string, stored: string) => Promise<boolean>;
}

export interface AccountStore {
  /** Creates the one Admin a fresh instance is claimed by, or refuses because it already has one. */
  claim(context: unknown, claim: InstanceClaim): Promise<AccountRecord>;
  claimed(context: unknown): Promise<boolean>;
  count(context: unknown): Promise<number>;
  /** The account these credentials belong to, or nothing at all — and the same work is done either way. */
  authenticate(context: unknown, credentials: SignIn): Promise<AccountRecord | undefined>;
}

export function accountsOn(db: AccountDb, options: AccountOptions): AccountStore {
  const newId = options.newId ?? ((): string => randomBytes(ACCOUNT_ID_BYTES).toString('base64url'));
  const hash = options.hash ?? hashPassword;
  const verify = options.verify ?? verifyPassword;

  // Derived on the first handle nobody holds and kept from then on. Eager would cost every deployment a
  // derivation at boot for something most never need; lazy costs the first such attempt two instead of
  // one, which makes one probe slower rather than any probe faster and so tells a caller nothing about
  // who exists. What it must never be is skipped: an answer that does no work is the stopwatch oracle.
  let noAccountsCredential: Promise<string> | undefined;
  const measuredAgainstNobody = (): Promise<string> => (noAccountsCredential ??= hash(DECOY));

  const permit = (context: unknown, need: AccountNeed): RequestContext => {
    const problems = contextProblems(context);
    if (problems.length > 0) throw new AccountError('context', `accounts: ${problems.join('; ')}`);
    const permission = ACCOUNT_PERMISSIONS[need];
    if (!(context as RequestContext).permissions.includes(permission)) {
      throw new AccountError('permission', `accounts: the actor may not ${need} an account, which needs ${permission}`);
    }
    return context as RequestContext;
  };

  const store: AccountStore = {
    async claim(context, claim) {
      permit(context, 'create');
      const id = newId();
      const parsed = parseAccountRecord({
        id,
        name: claim.name,
        displayName: claim.displayName,
        role: 'admin',
        createdAt: options.now(),
      });
      if (!parsed.ok) {
        const problems = parsed.problems.map((problem) => `${problem.path} ${problem.message}`).join('; ');
        throw new AccountError('schema', `an account this store would not read back: ${problems}`);
      }
      const record = parsed.value;
      const credential = await hash(claim.password);
      try {
        // The founder marker and the derived credential are the store's; `actorFor` is what durable
        // history carries, and neither of those two ever leaves this collection.
        await db.collection(ACCOUNTS_COLLECTION).insertOne({
          _id: record.id,
          name: record.name,
          displayName: record.displayName,
          role: record.role,
          createdAt: record.createdAt,
          credential,
          founder: true,
        });
      } catch (error: unknown) {
        if ((error as { code?: unknown }).code === DUPLICATE_KEY) {
          throw new AccountError('claimed', `${actorFor(record.id)} did not claim this instance: it has one already`);
        }
        throw error;
      }
      return record;
    },

    async authenticate(context, credentials) {
      permit(context, 'read');
      const found = await db.collection(ACCOUNTS_COLLECTION).findOne({ name: credentials.name });
      const stored = typeof found?.['credential'] === 'string' ? found['credential'] : await measuredAgainstNobody();
      const matches = await verify(credentials.password, stored);
      if (found === null || !matches) return undefined;
      const parsed = parseAccountRecord({
        id: found['_id'],
        name: found['name'],
        displayName: found['displayName'],
        role: found['role'],
        createdAt: found['createdAt'],
      });
      if (!parsed.ok) {
        const problems = parsed.problems.map((problem) => `${problem.path} ${problem.message}`).join('; ');
        throw new AccountError('schema', `an account this store cannot read back: ${problems}`);
      }
      return parsed.value;
    },

    async claimed(context) {
      permit(context, 'read');
      return (await db.collection(ACCOUNTS_COLLECTION).countDocuments({ founder: true })) > 0;
    },

    async count(context) {
      permit(context, 'read');
      return db.collection(ACCOUNTS_COLLECTION).countDocuments({});
    },
  };
  return Object.freeze(store);
}

const declaredIndex = (name: string): AccountIndex => {
  const index = ACCOUNT_INDEXES.find((candidate) => candidate.name === name);
  if (index === undefined) throw new AccountError('schema', `${name} is not an index the account store declares`);
  return index;
};

export async function createAccountIndexOn(db: IndexDb, index: AccountIndex): Promise<string> {
  declaredIndex(index.name);
  for (const field of Object.keys(index.keys)) {
    if (!CARRIED.has(field)) throw new AccountError('schema', `${index.name}: an account carries no field named ${field}`);
  }
  return db.collection(ACCOUNTS_COLLECTION).createIndex(index.keys, { name: index.name, ...index.options });
}

export async function dropAccountIndexOn(db: IndexDb, name: string): Promise<void> {
  declaredIndex(name);
  return db.collection(ACCOUNTS_COLLECTION).dropIndex(name);
}

/**
 * The driver satisfies this interface in practice; the cast is about the document types the driver
 * reports, which nothing here reads back.
 */
export function accountDb(db: Db): AccountDb {
  return { collection: (name) => db.collection(name) as unknown as AccountCollection };
}
