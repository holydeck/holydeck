// Where a Guest's or an output window's capability lives while it is good: server-side, keyed by a digest
// of a token this store never keeps a copy of, in a collection of its own.
//
// Requirement IDEN-08: a capability is not a session. It carries no identity, and it grants no control —
// an output capability's answer always says so, at the type level and not merely by convention. Nor is it
// cached anywhere above the database: every redemption reads the row live, so revoking one takes effect on
// the very next request rather than waiting for whatever holds it to reconnect. sessions.ts and totp.ts are
// precedent for the shape (opaque token, digest-keyed, injectable clock and token minting, a typed error
// kind) and nothing else — a capability shares no type and no collection with either.

import { createHash, randomBytes } from 'node:crypto';

import { contextProblems, requestContext } from './context.js';
import { droppedIndex } from './repositories.js';

import type { RequestContext } from './context.js';
import type { Db } from 'mongodb';
import type { Document, Filter } from './repositories.js';

export const CAPABILITIES_COLLECTION = 'capabilities';

export type CapabilityKind = 'guest' | 'output';

/** Never `'live-control'`: a capability presents a channel to watch, not the one an operator runs on. */
export type CapabilityView = 'audience' | 'stage' | 'singer';

/** What an actor needs to reach the store. Issuing and revoking are an operator's; redeeming is a viewer's. */
export const CAPABILITY_PERMISSIONS = Object.freeze({
  issue: 'capabilities.issue',
  redeem: 'capabilities.redeem',
  revoke: 'capabilities.revoke',
} as const);

export type CapabilityNeed = keyof typeof CAPABILITY_PERMISSIONS;

/** The database privileges this collection needs and no more: a capability is written once and removed. */
export const CAPABILITY_ACTIONS: readonly string[] = Object.freeze([
  'createIndex',
  'dropIndex',
  'find',
  'insert',
  'listIndexes',
  'remove',
]);

export function capabilityPrivileges(): { readonly collection: string; readonly actions: readonly string[] } {
  return { collection: CAPABILITIES_COLLECTION, actions: CAPABILITY_ACTIONS };
}

export interface CapabilityIndex {
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

// One index, and only one. A capability nobody revoked is not a capability that should outlive its own
// expiry, so the database forgets it rather than this process having to sweep for one.
const DECLARED_INDEXES: readonly CapabilityIndex[] = [
  { name: 'capability_expiry', keys: { expiresOn: 1 }, options: { expireAfterSeconds: 0 } },
];

export const CAPABILITY_INDEXES = Object.freeze(DECLARED_INDEXES);

/** Every field a capability document carries, so an index can only be declared over something one carries. */
const CARRIED = new Set<string>(['_id', 'kind', 'service', 'view', 'expiresAt', 'expiresOn', 'issuedBy']);

export type CapabilityRefusal = 'context' | 'permission' | 'schema' | 'unknown' | 'expired' | 'service' | 'view';

/** Carries why the call was refused, so a caller can tell a defect from a capability that simply ended. */
export class CapabilityError extends Error {
  readonly kind: CapabilityRefusal;

  constructor(kind: CapabilityRefusal, message: string) {
    super(message);
    this.name = 'CapabilityError';
    this.kind = kind;
  }
}

/** The slice of a Mongo collection the store uses. Narrow on purpose: a test can supply all of it. */
export interface CapabilityCollection {
  insertOne(document: Document): Promise<{ insertedId: unknown }>;
  findOne(filter: Filter): Promise<Document | null>;
  deleteOne(filter: Filter): Promise<{ deletedCount: number }>;
  deleteMany(filter: Filter): Promise<{ deletedCount: number }>;
  createIndex(keys: Readonly<Record<string, 1 | -1>>, options?: Readonly<Record<string, unknown>>): Promise<string>;
  dropIndex(index: string): Promise<void>;
}

export interface CapabilityDb {
  collection(name: string): CapabilityCollection;
}

/** Building an index needs no capability verb, so the call asks for none — the shape sessions and totp use. */
export interface IndexDb {
  collection(name: string): Pick<CapabilityCollection, 'createIndex' | 'dropIndex'>;
}

/** The digest a token is stored under. A copy of this collection redeems nobody's invitation. */
export const tokenDigest = (token: string): string => createHash('sha256').update(token).digest('hex');

/** The context the server reaches its own store under: itself, allowed to issue, redeem and revoke. */
export function capabilityContext(correlationId: string): RequestContext {
  return requestContext({
    actor: 'system',
    permissions: Object.values(CAPABILITY_PERMISSIONS),
    correlationId,
  });
}

/**
 * What redeeming answers with. A guest carries no identity at all — nothing here is a place to put one.
 * An output window's `canControl` and `grants` are literal types, `false` and `readonly []`, so no future
 * code path through this store can make either anything else: the type checker is the enforcement.
 */
export type RedeemedCapability =
  | { readonly kind: 'guest'; readonly service: string; readonly view: CapabilityView }
  | {
      readonly kind: 'output';
      readonly service: string;
      readonly view: CapabilityView;
      readonly canControl: false;
      readonly grants: readonly [];
    };

export interface CapabilityOptions {
  /** Injected, so every deadline this store writes or checks comes from one clock and a test does not wait. */
  readonly now: () => string;
  readonly newToken?: () => string;
}

export interface CapabilityStore {
  /** Mints a capability good until `expiresAt`, which must not already have passed. */
  issue(
    context: unknown,
    issuedBy: string,
    input: {
      readonly kind: CapabilityKind;
      readonly service: string;
      readonly view: CapabilityView;
      readonly expiresAt: string;
    },
  ): Promise<{ readonly token: string; readonly capabilityId: string }>;
  /** Read live against the database on every call — nothing above it is ever trusted to have the answer. */
  redeem(
    context: unknown,
    token: string,
    expected: { readonly service: string; readonly view: CapabilityView },
  ): Promise<RedeemedCapability>;
  /** Idempotent: revoking a capability that is not there, or not there any longer, is not a defect. */
  revoke(context: unknown, capabilityId: string): Promise<void>;
  /**
   * Restoring a backup puts data back that every issued capability predates. Nothing in the archive can
   * revoke them — capabilities are never in it — so the store has to be able to revoke all of them at
   * once, without needing to be told which were issued, the same reasoning `sessions.ts`'s own
   * `revokeEvery` acts on.
   */
  revokeEvery(context: unknown): Promise<number>;
}

const TOKEN_BYTES = 32;

/** The store over one database. Nothing here reads an ambient clock, database or current user. */
export function capabilitiesOn(db: CapabilityDb, options: CapabilityOptions): CapabilityStore {
  const newToken = options.newToken ?? ((): string => randomBytes(TOKEN_BYTES).toString('base64url'));
  const rows = (): CapabilityCollection => db.collection(CAPABILITIES_COLLECTION);

  const permit = (context: unknown, need: CapabilityNeed): void => {
    const problems = contextProblems(context);
    if (problems.length > 0) throw new CapabilityError('context', `capabilities: ${problems.join('; ')}`);
    const permission = CAPABILITY_PERMISSIONS[need];
    if (!(context as RequestContext).permissions.includes(permission)) {
      throw new CapabilityError(
        'permission',
        `capabilities: the actor may not ${need} a capability, which needs ${permission}`,
      );
    }
  };

  const store: CapabilityStore = {
    async issue(context, issuedBy, { kind, service, view, expiresAt }) {
      permit(context, 'issue');
      if (service.trim() === '') throw new CapabilityError('schema', 'capabilities: a capability is scoped to one service');
      if (kind === 'guest' && view !== 'audience') {
        throw new CapabilityError('schema', 'capabilities: a guest capability grants the audience view and no other');
      }
      const expiresOn = new Date(expiresAt);
      if (Number.isNaN(expiresOn.getTime()) || expiresOn.getTime() <= Date.parse(options.now())) {
        throw new CapabilityError('schema', 'capabilities: a capability needs an expiry that has not already passed');
      }
      const token = newToken();
      const capabilityId = tokenDigest(token);
      await rows().insertOne({ _id: capabilityId, kind, service, view, expiresAt, expiresOn, issuedBy });
      return { token, capabilityId };
    },

    async redeem(context, token, expected) {
      permit(context, 'redeem');
      const document = await rows().findOne({ _id: tokenDigest(token) });
      if (document === null) throw new CapabilityError('unknown', 'capabilities: there is no capability with that token');
      // Read against the injected clock rather than trusted to the expiry index: mongod removes a finished
      // capability when its background pass next comes round, which is after the deadline and not at it.
      if (Date.parse(String(document['expiresAt'])) <= Date.parse(options.now())) {
        await rows().deleteOne({ _id: document['_id'] as string });
        throw new CapabilityError('expired', 'capabilities: that capability is over and has been forgotten');
      }
      if (document['service'] !== expected.service) {
        throw new CapabilityError('service', 'capabilities: that capability was not issued for this service');
      }
      if (document['view'] !== expected.view) {
        throw new CapabilityError('view', 'capabilities: that capability was not issued for this view');
      }
      const kind = document['kind'] as CapabilityKind;
      const service = document['service'] as string;
      const view = document['view'] as CapabilityView;
      return kind === 'guest' ? { kind, service, view } : { kind, service, view, canControl: false, grants: [] };
    },

    async revoke(context, capabilityId) {
      permit(context, 'revoke');
      await rows().deleteOne({ _id: capabilityId });
    },

    async revokeEvery(context) {
      permit(context, 'revoke');
      const { deletedCount } = await rows().deleteMany({});
      return deletedCount;
    },
  };
  return Object.freeze(store);
}

const declaredIndex = (name: string): CapabilityIndex => {
  const index = CAPABILITY_INDEXES.find((candidate) => candidate.name === name);
  if (index === undefined) throw new CapabilityError('schema', `${name} is not an index the capability store declares`);
  return index;
};

export async function createCapabilityIndexOn(db: IndexDb, index: CapabilityIndex): Promise<string> {
  declaredIndex(index.name);
  for (const field of Object.keys(index.keys)) {
    if (!CARRIED.has(field)) {
      throw new CapabilityError('schema', `${index.name}: a capability carries no field named ${field}`);
    }
  }
  return db.collection(CAPABILITIES_COLLECTION).createIndex(index.keys, { name: index.name, ...index.options });
}

export async function dropCapabilityIndexOn(db: IndexDb, name: string): Promise<void> {
  declaredIndex(name);
  return droppedIndex(() => db.collection(CAPABILITIES_COLLECTION).dropIndex(name));
}

/**
 * The driver satisfies this interface in practice; the cast is about the document types the driver
 * reports.
 */
export function capabilityDb(db: Db): CapabilityDb {
  return { collection: (name) => db.collection(name) as unknown as CapabilityCollection };
}
