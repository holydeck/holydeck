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
import { droppedIndex } from './repositories.js';
import { hashPassword, verifyPassword } from './credentials.js';

import type { AccountRecord, AccountRole, CreateAccount, InstanceClaim, SignIn } from '@holydeck/contracts/accounts';
import type { Db } from 'mongodb';

import type { RequestContext } from './context.js';
import type { Document, Filter } from './repositories.js';

export const ACCOUNTS_COLLECTION = 'accounts';

/**
 * What an actor needs to reach the store. Creating an account is administration's; reading is anyone's;
 * updating is administration's too, and today the only thing it updates is Control presentation.
 */
export const ACCOUNT_PERMISSIONS = Object.freeze({
  create: 'accounts.create',
  read: 'accounts.read',
  update: 'accounts.update',
} as const);

export type AccountNeed = keyof typeof ACCOUNT_PERMISSIONS;

/**
 * The database privileges this collection needs. No `remove`: an account is closed by being written
 * differently, never by disappearing, and a deployment granting exactly this makes that the database's
 * rule.
 */
export const ACCOUNT_ACTIONS: readonly string[] = Object.freeze([
  'createIndex',
  'dropIndex',
  'find',
  'insert',
  'listIndexes',
  'update',
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
const CARRIED = new Set<string>([
  'id',
  'name',
  'displayName',
  'role',
  'createdAt',
  'controlPresentation',
  'disabled',
  '_id',
  'credential',
  'founder',
]);

export type AccountRefusal = 'context' | 'permission' | 'schema' | 'claimed' | 'duplicate';

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
  updateOne(filter: Filter, update: Document): Promise<{ matchedCount: number }>;
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
  /** The account an actor names, for a surface already holding a session: never a way to look for one. */
  read(context: unknown, id: string): Promise<AccountRecord | undefined>;
  /** Grants or revokes Control presentation for the named account. Nothing for an identifier no account holds. */
  grantControl(context: unknown, id: string, granted: boolean): Promise<AccountRecord | undefined>;
  /** Administers a new account into being, beyond the one founder `claim()` made. Refuses a name in use. */
  create(context: unknown, input: CreateAccount): Promise<AccountRecord>;
  /** Closes an account: kept, not deleted, and no longer able to authenticate. Nothing for an unknown id. */
  disable(context: unknown, id: string): Promise<AccountRecord | undefined>;
  /** Reopens a closed account. Nothing for an unknown id. */
  restore(context: unknown, id: string): Promise<AccountRecord | undefined>;
  /** Reassigns which of the three roles an account holds. Nothing for an unknown id. */
  assignRole(context: unknown, id: string, role: AccountRole): Promise<AccountRecord | undefined>;
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

  /**
   * The record, out of the document it is kept in. Everything the collection holds that an account is not
   * — the derived credential, the founder marker — stays here, because what is not read cannot be handed
   * to a caller by a later field being added to this list.
   */
  const readBack = (found: Document): AccountRecord => {
    const parsed = parseAccountRecord({
      id: found['_id'],
      name: found['name'],
      displayName: found['displayName'],
      role: found['role'],
      createdAt: found['createdAt'],
      // Absent on a document written before this flag existed. Reading it back as not holding it is the
      // migration: nothing anywhere is granted Control presentation by upgrading, only by being granted it.
      controlPresentation: found['controlPresentation'] ?? false,
      // Same precedent: an account written before this flag existed reads back as not disabled, not as a
      // defect. Nothing is closed by upgrading, only by being closed.
      disabled: found['disabled'] ?? false,
    });
    if (!parsed.ok) {
      const problems = parsed.problems.map((problem) => `${problem.path} ${problem.message}`).join('; ');
      throw new AccountError('schema', `an account this store cannot read back: ${problems}`);
    }
    return parsed.value;
  };

  /**
   * The one write shape `grantControl`, `disable`, `restore` and `assignRole` all are: set a field on the
   * account an id names, and answer nothing for an id nothing holds — including the id that stopped
   * holding it between this write and the read straight after.
   */
  const applyUpdate = async (id: string, set: Document): Promise<AccountRecord | undefined> => {
    const rows = db.collection(ACCOUNTS_COLLECTION);
    const { matchedCount } = await rows.updateOne({ _id: id }, { $set: set });
    if (matchedCount === 0) return undefined;
    const found = await rows.findOne({ _id: id });
    return found === null ? undefined : readBack(found);
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
        // Explicit, not implicit: the founder is Admin by role, and Admin does not carry this by being it.
        controlPresentation: false,
        disabled: false,
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
          controlPresentation: record.controlPresentation,
          disabled: record.disabled,
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

    async create(context, input) {
      permit(context, 'create');
      const id = newId();
      const parsed = parseAccountRecord({
        id,
        name: input.name,
        displayName: input.displayName,
        role: input.role,
        createdAt: options.now(),
        controlPresentation: false,
        disabled: false,
      });
      if (!parsed.ok) {
        const problems = parsed.problems.map((problem) => `${problem.path} ${problem.message}`).join('; ');
        throw new AccountError('schema', `an account this store would not read back: ${problems}`);
      }
      const record = parsed.value;
      const credential = await hash(input.password);
      try {
        await db.collection(ACCOUNTS_COLLECTION).insertOne({
          _id: record.id,
          name: record.name,
          displayName: record.displayName,
          role: record.role,
          createdAt: record.createdAt,
          controlPresentation: record.controlPresentation,
          disabled: record.disabled,
          credential,
          founder: false,
        });
      } catch (error: unknown) {
        if ((error as { code?: unknown }).code === DUPLICATE_KEY) {
          throw new AccountError('duplicate', `${actorFor(record.id)} was not created: another account already uses that name`);
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
      // Checked only after `verify` resolves, so a disabled account's attempt costs exactly what any other
      // account's does — no new timing oracle telling an attacker "this handle exists but is disabled"
      // faster or slower than "this password is wrong".
      if (found === null || !matches || found['disabled'] === true) return undefined;
      return readBack(found);
    },

    async read(context, id) {
      permit(context, 'read');
      const found = await db.collection(ACCOUNTS_COLLECTION).findOne({ _id: id });
      return found === null ? undefined : readBack(found);
    },

    async grantControl(context, id, granted) {
      permit(context, 'update');
      return applyUpdate(id, { controlPresentation: granted });
    },

    async disable(context, id) {
      permit(context, 'update');
      return applyUpdate(id, { disabled: true });
    },

    async restore(context, id) {
      permit(context, 'update');
      return applyUpdate(id, { disabled: false });
    },

    async assignRole(context, id, role) {
      permit(context, 'update');
      return applyUpdate(id, { role });
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
  return droppedIndex(() => db.collection(ACCOUNTS_COLLECTION).dropIndex(name));
}

/**
 * The driver satisfies this interface in practice; the cast is about the document types the driver
 * reports, which nothing here reads back.
 */
export function accountDb(db: Db): AccountDb {
  return { collection: (name) => db.collection(name) as unknown as AccountCollection };
}
