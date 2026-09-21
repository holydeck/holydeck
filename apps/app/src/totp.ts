// Where a second factor is kept: one credential per account, in a collection of its own.
//
// Its own collection rather than a field on the account, for the reason the sessions, the queue and the
// attempt gate each got one — a second factor is operational state that changes over its life, and the
// account record has no update verb at all, deliberately. Keeping it apart also means revoking a second
// factor cannot touch the password that stays behind it, because the store that could is not here.
//
// Two states, and the database enforces the one that matters. An enrolment is written pending and becomes
// the account's second factor only when a code has proved the secret arrived intact; enrolling again over
// a pending one replaces it, and over a proved one is a duplicate key rather than a read this code did
// first. A code is accepted at one step and never again, which is the same conditional write the attempt
// gate counts a failure with, and a recovery code is taken out of the set in the write that spends it.

import { isAccountId } from '@holydeck/contracts/accounts';

import { contextProblems, requestContext } from './context.js';
import { droppedIndex } from './repositories.js';
import { drawnRecoveryCodes, drawnSecret, matchedStep, recoveryDigest } from './otp.js';

import type { Db } from 'mongodb';

import type { RequestContext } from './context.js';
import type { Document, Filter } from './repositories.js';

export const TOTP_COLLECTION = 'totp_credentials';

/** What an actor needs to reach a second factor. Reading is a sign-in's; the rest is a person's own. */
export const TOTP_PERMISSIONS = Object.freeze({
  read: 'totp.read',
  write: 'totp.write',
} as const);

export type TotpNeed = keyof typeof TOTP_PERMISSIONS;

/**
 * The database privileges this collection needs and no more. `update` and `insert` are one operation
 * again: the first enrolment upserts a credential into existence. `remove` is what revoking is, and there
 * is nothing wider, so a deployment that grants exactly this grants the store nothing anywhere else.
 */
export const TOTP_ACTIONS: readonly string[] = Object.freeze([
  'createIndex',
  'dropIndex',
  'find',
  'insert',
  'listIndexes',
  'remove',
  'update',
]);

export function totpPrivileges(): { readonly collection: string; readonly actions: readonly string[] } {
  return { collection: TOTP_COLLECTION, actions: TOTP_ACTIONS };
}

export interface TotpIndex {
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

// One index, and only one. The account's identifier is the document's `_id`, so "one credential per
// account" is already the database's rule. The expiry is the other half: an enrolment nobody proved is a
// secret on somebody's screen that was never used, and it stops existing rather than waiting for a sweep.
// A proved credential carries no `pendingUntil` at all, which is what keeps this index off it forever.
const DECLARED_INDEXES: readonly TotpIndex[] = [
  { name: 'totp_pending_expiry', keys: { pendingUntil: 1 }, options: { expireAfterSeconds: 0 } },
];

export const TOTP_INDEXES = Object.freeze(DECLARED_INDEXES);

/** Every field a credential holds, so an index can only be declared over something one carries. */
const CARRIED = new Set<string>([
  '_id',
  'secret',
  'status',
  'pendingUntil',
  'enrolledAt',
  'provedAt',
  'lastUsedStep',
  'recovery',
  'usedAt',
]);

/**
 * How long an enrolment stays open. Long enough to find the phone, scan the square and type what it shows;
 * short enough that a secret displayed and walked away from is not still enrollable tomorrow.
 */
export const ENROLMENT_MINUTES = 15;

const PENDING = 'pending';

const ACTIVE = 'active';

export type TotpRefusal = 'context' | 'permission' | 'schema' | 'state' | 'duplicate';

/** Carries why the call was refused, so a caller can tell a defect from a state it asked the wrong thing of. */
export class TotpError extends Error {
  readonly kind: TotpRefusal;

  constructor(kind: TotpRefusal, message: string) {
    super(message);
    this.name = 'TotpError';
    this.kind = kind;
  }
}

export interface FoundOptions {
  readonly returnDocument: 'after';
  readonly upsert: boolean;
}

/** The slice of a Mongo collection the store uses. Narrow on purpose: a test can supply all of it. */
export interface TotpCollection {
  findOne(filter: Filter): Promise<Document | null>;
  findOneAndUpdate(filter: Filter, update: Document, options: FoundOptions): Promise<Document | null>;
  deleteOne(filter: Filter): Promise<{ deletedCount: number }>;
  createIndex(keys: Readonly<Record<string, 1 | -1>>, options?: Readonly<Record<string, unknown>>): Promise<string>;
  dropIndex(index: string): Promise<void>;
}

export interface TotpDb {
  collection(name: string): TotpCollection;
}

/** Building an index needs no second-factor verb, so the call asks for none — the shape sessions uses. */
export interface IndexDb {
  collection(name: string): Pick<TotpCollection, 'createIndex' | 'dropIndex'>;
}

/** The context the server reaches its own store under: itself, allowed to read and to write, no more. */
export function totpContext(correlationId: string): RequestContext {
  return requestContext({
    actor: 'system',
    permissions: Object.values(TOTP_PERMISSIONS),
    correlationId,
  });
}

/** What a sign-in learns by presenting whatever the person typed: nothing is owed, or it is or is not. */
export type SecondFactorAnswer = 'none' | 'accepted' | 'refused';

export interface TotpOptions {
  /** Injected, so every deadline one store writes comes from one clock and a test does not have to wait. */
  readonly now: () => string;
}

export interface TotpStore {
  /** Opens an enrolment and answers with the secret to show once. Refused over a proved second factor. */
  enroll(context: unknown, account: string): Promise<{ readonly secret: string }>;
  /** Proves an enrolment with one code, answering with the recovery codes, or with nothing if it was wrong. */
  verify(context: unknown, account: string, code: string): Promise<readonly string[] | undefined>;
  /** What a sign-in asks: whether this account owes a second factor, and whether what was typed was it. */
  satisfied(context: unknown, account: string, code: string): Promise<SecondFactorAnswer>;
  /** A new set of recovery codes, which is how a set that was read aloud or printed stops being one. */
  regenerate(context: unknown, account: string): Promise<readonly string[]>;
  /** Removes the credential, proved or not, answering whether there was one. The password is untouched. */
  revoke(context: unknown, account: string): Promise<boolean>;
}

const MINUTE_MS = 60_000;

const after = (instant: string, milliseconds: number): Date => new Date(Date.parse(instant) + milliseconds);

const isDuplicate = (error: unknown): boolean => (error as { code?: unknown }).code === 11_000;

/** The store over one database. Nothing here reads an ambient clock, database or current user. */
export function totpsOn(db: TotpDb, options: TotpOptions): TotpStore {
  const rows = (): TotpCollection => db.collection(TOTP_COLLECTION);

  /** The three questions every verb asks before it touches the collection. */
  const permit = (context: unknown, account: string, need: TotpNeed): void => {
    const problems = contextProblems(context);
    if (problems.length > 0) throw new TotpError('context', `totp: ${problems.join('; ')}`);
    const permission = TOTP_PERMISSIONS[need];
    if (!(context as RequestContext).permissions.includes(permission)) {
      throw new TotpError('permission', `totp: the actor may not ${need} a second factor, which needs ${permission}`);
    }
    if (!isAccountId(account)) throw new TotpError('schema', 'totp: a second factor belongs to one account');
  };

  const proved = async (account: string): Promise<Document | null> => rows().findOne({ _id: account, status: ACTIVE });

  const store: TotpStore = {
    async enroll(context, account) {
      permit(context, account, 'write');
      const secret = drawnSecret();
      const now = options.now();
      try {
        // Filtered on the pending state so the upsert has nothing to match when a proved credential is
        // there, and inserting over that identifier is the duplicate key. The refusal is the database's,
        // which is what a read of our own could not promise against a second request arriving together.
        await rows().findOneAndUpdate(
          { _id: account, status: PENDING },
          {
            $set: {
              secret,
              status: PENDING,
              enrolledAt: now,
              pendingUntil: after(now, ENROLMENT_MINUTES * MINUTE_MS),
            },
          },
          { returnDocument: 'after', upsert: true },
        );
      } catch (error) {
        if (!isDuplicate(error)) throw error;
        throw new TotpError('duplicate', 'totp: that account already holds a second factor');
      }
      return { secret };
    },

    async verify(context, account, code) {
      permit(context, account, 'write');
      const now = options.now();
      const open = await rows().findOne({ _id: account, status: PENDING });
      // Read against the injected clock rather than trusted to the expiry index: mongod removes a finished
      // enrolment when its background pass next comes round, which is after the deadline and not at it.
      if (open === null || Date.parse(String(open['pendingUntil'])) <= Date.parse(now)) {
        throw new TotpError('state', 'totp: that account has no enrolment waiting to be proved');
      }
      const step = matchedStep(String(open['secret']), code, now);
      if (step === undefined) return undefined;
      const codes = drawnRecoveryCodes();
      const promoted = await rows().findOneAndUpdate(
        { _id: account, status: PENDING },
        {
          $set: { status: ACTIVE, provedAt: now, lastUsedStep: step, recovery: codes.map(recoveryDigest) },
          $unset: { pendingUntil: '' },
        },
        { returnDocument: 'after', upsert: false },
      );
      // The enrolment went away between the two, which is the expiry or a revocation arriving in between.
      // Answering with codes nothing is holding the digests of would be handing out ten dead ones.
      if (promoted === null) throw new TotpError('state', 'totp: that enrolment was gone before it was proved');
      return codes;
    },

    async satisfied(context, account, code) {
      permit(context, account, 'read');
      const now = options.now();
      const credential = await proved(account);
      // An account with nothing proved is asked for nothing. A pending enrolment is not a second factor:
      // it is a secret that has never been shown to work, and locking somebody out behind one would be
      // this release's own doing rather than anything they chose.
      if (credential === null) return 'none';
      const step = matchedStep(String(credential['secret']), code, now);
      if (step !== undefined) {
        // The step has to be ahead of the last one spent, in the write that spends it. A code read over a
        // shoulder is still the code for its step for thirty seconds, and this is what that buys nobody.
        const spent = await rows().findOneAndUpdate(
          { _id: account, status: ACTIVE, lastUsedStep: { $lt: step } },
          { $set: { lastUsedStep: step, usedAt: now } },
          { returnDocument: 'after', upsert: false },
        );
        return spent === null ? 'refused' : 'accepted';
      }
      // Not a code this secret gives, so it is either a recovery code or nothing. Taken out of the set in
      // the write that accepts it, so two requests presenting one recovery code spend it exactly once.
      const digest = recoveryDigest(code);
      const used = await rows().findOneAndUpdate(
        { _id: account, status: ACTIVE, recovery: digest },
        { $pull: { recovery: digest }, $set: { usedAt: now } },
        { returnDocument: 'after', upsert: false },
      );
      return used === null ? 'refused' : 'accepted';
    },

    async regenerate(context, account) {
      permit(context, account, 'write');
      const codes = drawnRecoveryCodes();
      const replaced = await rows().findOneAndUpdate(
        { _id: account, status: ACTIVE },
        { $set: { recovery: codes.map(recoveryDigest), usedAt: options.now() } },
        { returnDocument: 'after', upsert: false },
      );
      if (replaced === null) throw new TotpError('state', 'totp: that account holds no second factor to replace');
      return codes;
    },

    async revoke(context, account) {
      permit(context, account, 'write');
      // The whole credential, pending or proved. What is left is the password, which lives elsewhere and
      // is not reachable from here — a revocation that could disable an account would be a worse thing.
      const { deletedCount } = await rows().deleteOne({ _id: account });
      return deletedCount > 0;
    },
  };
  return Object.freeze(store);
}

const declaredIndex = (name: string): TotpIndex => {
  const index = TOTP_INDEXES.find((candidate) => candidate.name === name);
  if (index === undefined) throw new TotpError('schema', `${name} is not an index the second factor declares`);
  return index;
};

export async function createTotpIndexOn(db: IndexDb, index: TotpIndex): Promise<string> {
  declaredIndex(index.name);
  for (const field of Object.keys(index.keys)) {
    if (!CARRIED.has(field)) {
      throw new TotpError('schema', `${index.name}: a credential carries no field named ${field}`);
    }
  }
  return db.collection(TOTP_COLLECTION).createIndex(index.keys, { name: index.name, ...index.options });
}

export async function dropTotpIndexOn(db: IndexDb, name: string): Promise<void> {
  declaredIndex(name);
  return droppedIndex(() => db.collection(TOTP_COLLECTION).dropIndex(name));
}

/**
 * The driver satisfies this interface in practice; the cast is about the document types the driver
 * reports, and about an upsert answering with a document rather than with one or nothing.
 */
export function totpDb(db: Db): TotpDb {
  return { collection: (name) => db.collection(name) as unknown as TotpCollection };
}
