// What stands between a password and the person guessing at it: a count of failures per scope, and a
// wait that grows every time a scope earns another one.
//
// A sign-in asks this gate before it reads a credential and tells it afterwards, which is the order that
// matters — a gate consulted after the derivation has already been paid for is a gate that lets an
// attacker spend the server's CPU for free. Operational state again, so the same road the sessions, the
// queue and the accounts took: one collection, its own permissions, its own privileges, its own indexes.
//
// Two scopes, counted apart. An account's scope is the handle a request asked for, whether or not anybody
// holds it, and an address's is a digest of where the request came from. Neither is a substitute for the
// other: counting only accounts lets one address work through a dictionary of handles, and counting only
// addresses lets a botnet work through one account from a thousand of them.

import { createHash } from 'node:crypto';

import { contextProblems, requestContext } from './context.js';
import { droppedIndex } from './repositories.js';

import type { Db } from 'mongodb';

import type { RequestContext } from './context.js';
import type { Document, Filter } from './repositories.js';

export const ATTEMPTS_COLLECTION = 'sign_in_attempts';

/** What an actor needs to reach the gate. Asking is a guard's; counting and forgiving are a sign-in's. */
export const ATTEMPT_PERMISSIONS = Object.freeze({
  read: 'attempts.read',
  write: 'attempts.write',
} as const);

export type AttemptNeed = keyof typeof ATTEMPT_PERMISSIONS;

/**
 * The database privileges this collection needs and no more. `update` and `insert` are one operation here:
 * the first failure against a scope upserts it into existence, which Mongo authorises as both. `remove` is
 * what forgiving a scope is, and there is no `listCollections` or anything wider, because a deployment
 * that grants exactly this list grants the gate nothing it could use on another collection.
 */
export const ATTEMPT_ACTIONS: readonly string[] = Object.freeze([
  'createIndex',
  'dropIndex',
  'find',
  'insert',
  'listIndexes',
  'remove',
  'update',
]);

export function attemptPrivileges(): { readonly collection: string; readonly actions: readonly string[] } {
  return { collection: ATTEMPTS_COLLECTION, actions: ATTEMPT_ACTIONS };
}

export interface AttemptIndex {
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

// One index, and deliberately only one. A scope is the document's `_id`, so "one document per scope" is
// already the database's rule and a unique index over it would only repeat the one Mongo builds for every
// collection. The expiry index is the other half: a scope nobody has failed against for a day is a scope
// nobody is being attacked at, and it stops existing rather than accumulating until someone sweeps.
const DECLARED_INDEXES: readonly AttemptIndex[] = [
  { name: 'attempt_expiry', keys: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } },
];

export const ATTEMPT_INDEXES = Object.freeze(DECLARED_INDEXES);

/** Every field the collection holds, so an index can only be declared over something a scope carries. */
const CARRIED = new Set<string>(['_id', 'failures', 'locks', 'lockedUntil', 'expiresAt']);

/**
 * How many failures a scope of each kind is allowed before it locks. An account's is low because ten
 * wrong passwords in a row is nobody's honest afternoon; an address's is far higher because a household,
 * an office and a mobile network all arrive as one address and would otherwise lock each other out.
 */
export const ACCOUNT_ATTEMPT_LIMIT = 10;

export const ADDRESS_ATTEMPT_LIMIT = 50;

/**
 * What a scope waits, in minutes, the first time it locks and every time after that. Growing rather than
 * fixed: a wrong password twice is a person who mistyped, and the same scope locking a fourth time is not.
 */
export const LOCK_MINUTES: readonly number[] = Object.freeze([1, 5, 15, 60]);

/** How long a scope is kept after its last failure. Long enough to outlive a slow attack, short enough
 * that yesterday's wrong password is not held against anybody today. */
export const ATTEMPT_RETENTION_HOURS = 24;

export type AttemptRefusal = 'context' | 'permission' | 'schema';

/** Carries why the call was refused, so a caller can tell a defect from a scope it named wrongly. */
export class AttemptError extends Error {
  readonly kind: AttemptRefusal;

  constructor(kind: AttemptRefusal, message: string) {
    super(message);
    this.name = 'AttemptError';
    this.kind = kind;
  }
}

export interface FoundOptions {
  readonly returnDocument: 'after';
  readonly upsert: true;
}

/**
 * The slice of a Mongo collection the gate uses. Narrow on purpose: a test can supply all of it. The
 * upsert answers with the document after the change and never with nothing, which is what lets one write
 * both count a failure and say whether that failure was the one that reached the limit.
 */
export interface AttemptCollection {
  findOne(filter: Filter): Promise<Document | null>;
  findOneAndUpdate(filter: Filter, update: Document, options: FoundOptions): Promise<Document>;
  updateOne(filter: Filter, update: Document): Promise<{ matchedCount: number }>;
  deleteOne(filter: Filter): Promise<{ deletedCount: number }>;
  createIndex(keys: Readonly<Record<string, 1 | -1>>, options?: Readonly<Record<string, unknown>>): Promise<string>;
  dropIndex(index: string): Promise<void>;
}

export interface AttemptDb {
  collection(name: string): AttemptCollection;
}

/** Building an index needs no attempt verb, so the call asks for none — the shape sessions uses. */
export interface IndexDb {
  collection(name: string): Pick<AttemptCollection, 'createIndex' | 'dropIndex'>;
}

/** The context the server reaches its own gate under: itself, allowed to ask and to count, nothing else. */
export function attemptContext(correlationId: string): RequestContext {
  return requestContext({
    actor: 'system',
    permissions: Object.values(ATTEMPT_PERMISSIONS),
    correlationId,
  });
}

const ACCOUNT_PREFIX = 'account:';

const ADDRESS_PREFIX = 'address:';

/**
 * The scope a handle is counted under.
 *
 * It is the handle the request asked for, not an account that was found — the gate is asked before the
 * sign-in route knows whether anybody holds it. Were only real handles counted, the lock would answer the
 * question the route exists to refuse: an attacker would learn an account exists by guessing at it until
 * it locked, and learn it does not by guessing forever. A handle nobody holds locks like any other.
 */
export const accountScope = (handle: string): string => `${ACCOUNT_PREFIX}${handle}`;

/** The scope an address is counted under: a digest, so a copy of this collection is nobody's address log. */
export const addressScope = (address: string): string =>
  `${ADDRESS_PREFIX}${createHash('sha256').update(address).digest('hex')}`;

const LIMITS: readonly { readonly prefix: string; readonly limit: number }[] = [
  { prefix: ACCOUNT_PREFIX, limit: ACCOUNT_ATTEMPT_LIMIT },
  { prefix: ADDRESS_PREFIX, limit: ADDRESS_ATTEMPT_LIMIT },
];

/**
 * How many failures this scope is allowed, read out of the scope itself rather than taken from the
 * caller: a sign-in that handed an address's limit to an account would quietly raise that account's
 * ceiling fivefold, and no call site can make that mistake if no call site is asked.
 *
 * Every verb asks, including the two that have no use for the number, because a gate that answered "not
 * locked" for a scope it cannot put a limit on would be the one failure here that fails open.
 */
function limitFor(scope: string): number {
  const known = LIMITS.find((candidate) => scope.startsWith(candidate.prefix));
  if (known === undefined) {
    throw new AttemptError('schema', `${scope} names neither an account nor an address to count against`);
  }
  return known.limit;
}

/** The window a scope waits on its nth lock, holding at the last one however often it locks again. */
const windowFor = (locks: number): number => LOCK_MINUTES[Math.min(locks, LOCK_MINUTES.length) - 1]!;

const MINUTE_MS = 60_000;

const HOUR_MS = 3_600_000;

const after = (instant: string, milliseconds: number): Date => new Date(Date.parse(instant) + milliseconds);

/** Written by this gate, incremented by the database: never absent, and never anything but a number. */
const counted = (document: Document, field: string): number => Number(document[field]);

export interface AttemptOptions {
  /** Injected, so every deadline one gate writes comes from one clock and a test does not have to wait. */
  readonly now: () => string;
}

export interface AttemptGate {
  /** Whether this scope is refused right now. Asked before a credential is read, never after. */
  locked(context: unknown, scope: string): Promise<boolean>;
  /** Records one failure, answering whether that failure was the one that locked the scope. */
  failed(context: unknown, scope: string): Promise<boolean>;
  /** A success clears the scope completely, the backoff it had earned included. */
  forgiven(context: unknown, scope: string): Promise<void>;
}

/** The gate over one database. Nothing here reads an ambient clock, database or current user. */
export function attemptsOn(db: AttemptDb, options: AttemptOptions): AttemptGate {
  /** The three questions every verb asks before it touches the collection, answering with the limit. */
  const permit = (context: unknown, scope: string, need: AttemptNeed): number => {
    const problems = contextProblems(context);
    if (problems.length > 0) throw new AttemptError('context', `attempts: ${problems.join('; ')}`);
    const permission = ATTEMPT_PERMISSIONS[need];
    if (!(context as RequestContext).permissions.includes(permission)) {
      throw new AttemptError('permission', `attempts: the actor may not ${need} an attempt, which needs ${permission}`);
    }
    return limitFor(scope);
  };

  const gate: AttemptGate = {
    async locked(context, scope) {
      permit(context, scope, 'read');
      const document = await db.collection(ATTEMPTS_COLLECTION).findOne({ _id: scope });
      if (document === null) return false;
      // The expiry index is housekeeping, not this answer: mongod removes a finished scope when its
      // background pass next comes round, which is after the deadline rather than at it. So whether a
      // scope is refused is decided against the injected clock, and a document still sitting there past
      // its lock reads as free — which is also why moving that clock is how a test proves the release.
      const until = document['lockedUntil'];
      return typeof until === 'string' && Date.parse(until) > Date.parse(options.now());
    },

    async failed(context, scope) {
      const limit = permit(context, scope, 'write');
      const rows = db.collection(ATTEMPTS_COLLECTION);
      const now = options.now();
      // One write counts the failure and answers with the count, so two requests failing together are two
      // failures rather than one: read-then-write would let both read the ninth and both write the tenth.
      const scoped = await rows.findOneAndUpdate(
        { _id: scope },
        {
          $inc: { failures: 1 },
          $set: { expiresAt: after(now, ATTEMPT_RETENTION_HOURS * HOUR_MS) },
          $setOnInsert: { locks: 0 },
        },
        { returnDocument: 'after', upsert: true },
      );
      if (counted(scoped, 'failures') < limit) return false;
      // Locking is the second write because which window this is depends on what the first one answered.
      // The count starts again at zero: the next window is earned by fresh failures, not by old ones.
      const locks = counted(scoped, 'locks') + 1;
      await rows.updateOne(
        { _id: scope },
        { $set: { failures: 0, locks, lockedUntil: after(now, windowFor(locks) * MINUTE_MS).toISOString() } },
      );
      return true;
    },

    async forgiven(context, scope) {
      permit(context, scope, 'write');
      // Removed rather than zeroed: a scope that has proved itself keeps no backoff to serve later, and a
      // document that is not there is the same answer as one that says nothing happened.
      await db.collection(ATTEMPTS_COLLECTION).deleteOne({ _id: scope });
    },
  };
  return Object.freeze(gate);
}

const declaredIndex = (name: string): AttemptIndex => {
  const index = ATTEMPT_INDEXES.find((candidate) => candidate.name === name);
  if (index === undefined) throw new AttemptError('schema', `${name} is not an index the attempt gate declares`);
  return index;
};

export async function createAttemptIndexOn(db: IndexDb, index: AttemptIndex): Promise<string> {
  declaredIndex(index.name);
  for (const field of Object.keys(index.keys)) {
    if (!CARRIED.has(field)) throw new AttemptError('schema', `${index.name}: a scope carries no field named ${field}`);
  }
  return db.collection(ATTEMPTS_COLLECTION).createIndex(index.keys, { name: index.name, ...index.options });
}

export async function dropAttemptIndexOn(db: IndexDb, name: string): Promise<void> {
  declaredIndex(name);
  return droppedIndex(() => db.collection(ATTEMPTS_COLLECTION).dropIndex(name));
}

/**
 * The driver satisfies this interface in practice; the cast is about the document types the driver
 * reports, and about the upsert answering with a document rather than with one or nothing.
 */
export function attemptDb(db: Db): AttemptDb {
  return { collection: (name) => db.collection(name) as unknown as AttemptCollection };
}
