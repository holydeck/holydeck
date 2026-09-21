// Who is editing what, right now, and nothing more than that (spec COLL-01).
//
// Presence is operational state, not history, so it does not go through the repositories in records.ts —
// the same road the queue took, and for the same reason: an entry that is refreshed is an entry that is
// updated, and that layer has no update verb on purpose (ADR 0009). This collection is its own, with its
// own permissions and its own indexes.
//
// The one promise here is the promise not to make one. Nothing below asks whether anybody else is already
// editing, and nothing below can answer "no, you may not": `enter` takes no lock, checks no exclusivity
// and cannot be refused for anything but a context this code will not act on. That is what "without hard
// locks" means — not a lock that is usually granted, but no lock at all. Two editors on one piece of
// content is an ordinary state of affairs the product shows rather than an error it prevents, and what
// happens if they both save is the revision store's business (a conflict, preserved in conflicts.ts)
// rather than something presence was supposed to have stopped.
//
// An entry runs out rather than being swept. There is no Mongo TTL index here, exactly as the queue has
// none: a reader filters on `expiresAt` against the clock it was given, so an entry stops being present
// at the instant it says so and not at whatever later moment a background sweep would have got to it.
//
// Every time here is written by one clock in one format, because the database compares an expiry as text.

import { PRESENCE_KEY_SEPARATOR, parsePresenceEntry, presenceKey } from '@holydeck/contracts/presence';

import { contextProblems, requestContext } from './context.js';
import { droppedIndex } from './repositories.js';

import type { PresenceEntry } from '@holydeck/contracts/presence';
import type { Db } from 'mongodb';

import type { RequestContext } from './context.js';
import type { Document, Filter, ReadOptions } from './repositories.js';

export const PRESENCE_COLLECTION = 'presence';

/**
 * What an actor needs to reach presence. Leaving is the other half of entering and needs the same thing:
 * an editor who was allowed to say they are here is allowed to say they are not, and an editor who was
 * never allowed to enter has nothing to leave.
 */
export const PRESENCE_PERMISSIONS = Object.freeze({
  enter: 'presence.enter',
  read: 'presence.read',
} as const);

export type PresenceNeed = keyof typeof PRESENCE_PERMISSIONS;

/** How long an entry stands without being refreshed. Long enough to survive a slow tab, short enough that a closed one goes. */
export const DEFAULT_PRESENCE_MS = 30_000;

/**
 * The database privileges this collection needs and no more. `insert` and `update` are one operation
 * here: entering upserts the entry into existence and refreshing it updates the same document. `remove`
 * is what leaving is.
 */
export const PRESENCE_ACTIONS: readonly string[] = Object.freeze([
  'createIndex',
  'dropIndex',
  'find',
  'insert',
  'listIndexes',
  'remove',
  'update',
]);

export function presencePrivileges(): { readonly collection: string; readonly actions: readonly string[] } {
  return { collection: PRESENCE_COLLECTION, actions: PRESENCE_ACTIONS };
}

export interface PresenceIndex {
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

// One index, and it serves the only read this store makes: everyone still editing one piece of content,
// oldest arrival first. `expiresAt` is in it because that read filters on it on every tick of every open
// editor, and it carries no `expireAfterSeconds`: an entry is filtered out at the instant it expires,
// which is a stronger promise than a sweep that runs when it runs. One entry per editor per content is
// the `_id`'s rule rather than an index's, because the key is the pair.
const DECLARED_INDEXES: readonly PresenceIndex[] = [
  { name: 'presence_live', keys: { contentId: 1, expiresAt: 1, enteredAt: 1 }, options: {} },
];

export const PRESENCE_INDEXES = Object.freeze(DECLARED_INDEXES);

export type PresenceRefusal = 'context' | 'permission' | 'schema';

/** Carries why the call was refused. Never "somebody else is editing this": that is not a refusal here. */
export class PresenceError extends Error {
  readonly kind: PresenceRefusal;

  constructor(kind: PresenceRefusal, message: string) {
    super(message);
    this.name = 'PresenceError';
    this.kind = kind;
  }
}

export interface UpsertOptions {
  readonly returnDocument: 'after';
  readonly upsert: true;
}

/** The slice of a Mongo collection presence uses. Narrow on purpose: a test can supply all of it. */
export interface PresenceCollection {
  findOne(filter: Filter): Promise<Document | null>;
  findOneAndUpdate(filter: Filter, update: Document, options: UpsertOptions): Promise<Document>;
  find(filter: Filter, options?: ReadOptions): { toArray(): Promise<Document[]> };
  deleteOne(filter: Filter): Promise<{ deletedCount: number }>;
  createIndex(keys: Readonly<Record<string, 1 | -1>>, options?: Readonly<Record<string, unknown>>): Promise<string>;
  dropIndex(index: string): Promise<void>;
}

export interface PresenceDb {
  collection(name: string): PresenceCollection;
}

/** Building an index needs no presence verb, so the call asks for none — the shape the queue uses. */
export interface IndexDb {
  collection(name: string): Pick<PresenceCollection, 'createIndex' | 'dropIndex'>;
}

/** The context an editor observes presence under: themselves, allowed to be seen and to see. */
export function editorPresence(actor: string, correlationId: string): RequestContext {
  return requestContext({ actor, permissions: Object.values(PRESENCE_PERMISSIONS), correlationId });
}

// Mongo compares `expiresAt` as a string, which is the comparison of the instants it names only while
// every one of them is written the same way. A clock that writes them any other way is refused here
// rather than producing an entry that never expires or one that expired before it was written.
const CANONICAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const checkTime = (value: string): string => {
  if (!CANONICAL_TIME.test(value)) {
    throw new PresenceError(
      'schema',
      `presence is compared as text, so ${value} has to be an instant in UTC written with milliseconds`,
    );
  }
  return value;
};

export const presenceExpiry = (now: string, presenceMs: number): string =>
  new Date(Date.parse(checkTime(now)) + presenceMs).toISOString();

/** Everyone still editing this content at this instant. The filter is the whole of the expiry rule. */
export const livingFilter = (contentId: string, now: string): Filter => ({
  contentId,
  expiresAt: { $gt: checkTime(now) },
});

/**
 * The content half of an entry's key, refused before it is used as one. An identifier carrying the
 * separator would name a different pair once the editor's name was put after it, which is a row this
 * store would be reading and writing under somebody else's identity.
 */
const checkContentId = (contentId: string): string => {
  if (contentId.includes(PRESENCE_KEY_SEPARATOR)) {
    throw new PresenceError(
      'schema',
      `${contentId} cannot be a content identifier: ${PRESENCE_KEY_SEPARATOR} separates it from the editor in an entry's key`,
    );
  }
  return contentId;
};

/** Every field an entry carries, so an index can only be declared over something an entry has. */
const CARRIED = new Set<string>(['_id', 'contentId', 'actor', 'enteredAt', 'heartbeatAt', 'expiresAt']);

const declaredIndex = (name: string): PresenceIndex => {
  const index = PRESENCE_INDEXES.find((candidate) => candidate.name === name);
  if (index === undefined) throw new PresenceError('schema', `${name} is not an index presence declares`);
  return index;
};

/**
 * Indexes are not entries: building one changes how presence is read, never what it holds, which is why
 * a migration may do it. Only the ones presence declares, and only over fields an entry carries.
 */
export function createPresenceIndexOn(db: IndexDb, index: PresenceIndex): Promise<string> {
  declaredIndex(index.name);
  for (const field of Object.keys(index.keys)) {
    if (!CARRIED.has(field)) throw new PresenceError('schema', `${index.name}: an entry carries no field named ${field}`);
  }
  return db.collection(PRESENCE_COLLECTION).createIndex(index.keys, { name: index.name, ...index.options });
}

export function dropPresenceIndexOn(db: IndexDb, name: string): Promise<void> {
  declaredIndex(name);
  return droppedIndex(() => db.collection(PRESENCE_COLLECTION).dropIndex(name));
}

const readable = (problems: readonly { readonly path: string; readonly message: string }[]): string =>
  problems.map((problem) => `${problem.path} ${problem.message}`).join('; ');

/** Grades an entry against the contract, on the way in and on the way out, saying which way it went. */
function graded(value: unknown, what: string): PresenceEntry {
  const parsed = parsePresenceEntry(value, 'presence');
  if (!parsed.ok) throw new PresenceError('schema', `${what}: ${readable(parsed.problems)}`);
  return parsed.value;
}

/**
 * Grades a stored document against the contract, so an entry this code cannot read is never served. The
 * key is checked against the pair the entry claims to be, because that is the one thing about a row this
 * store cannot get wrong on its own.
 */
export function entryFrom(document: Document): PresenceEntry {
  const { _id: key, ...fields } = document;
  const entry = graded(fields, 'presence holds an entry this code cannot read');
  const own = presenceKey(entry.contentId, entry.actor);
  if (key !== own) throw new PresenceError('schema', `presence holds the entry ${own} under the key ${String(key)}`);
  return entry;
}

export interface PresenceOptions {
  /** Injected so a test can pin an expiry, and so every instant in one feed comes from one clock. */
  readonly now: () => string;
  readonly presenceMs?: number;
}

export interface PresenceStore {
  /**
   * Says this actor is editing this content, and says it again every time it is called. Never refused
   * for anybody else being here: there is no exclusivity to check and no lock to fail to take.
   */
  enter(context: unknown, input: { readonly contentId: string }): Promise<PresenceEntry>;
  /** Everyone whose entry has not run out, oldest arrival first. Expiry is decided by the reader's clock. */
  list(context: unknown, contentId: string): Promise<readonly PresenceEntry[]>;
  /** Leaving on purpose, rather than by falling silent. Answers false when there was nothing to leave. */
  leave(context: unknown, input: { readonly contentId: string }): Promise<boolean>;
}

/** Presence over one database. Nothing here reads an ambient clock, a global database or a current user. */
export function presenceOn(db: PresenceDb, options: PresenceOptions): PresenceStore {
  const presenceMs = options.presenceMs ?? DEFAULT_PRESENCE_MS;
  const collection = (): PresenceCollection => db.collection(PRESENCE_COLLECTION);
  const clock = (): string => checkTime(options.now());

  const permit = (context: unknown, need: PresenceNeed): RequestContext => {
    const problems = contextProblems(context);
    if (problems.length > 0) throw new PresenceError('context', `presence: ${problems.join('; ')}`);
    const permission = PRESENCE_PERMISSIONS[need];
    if (!(context as RequestContext).permissions.includes(permission)) {
      throw new PresenceError('permission', `presence: the actor may not ${need}, which needs ${permission}`);
    }
    return context as RequestContext;
  };

  const store: PresenceStore = {
    async enter(context, { contentId }) {
      const { actor } = permit(context, 'enter');
      const key = presenceKey(checkContentId(contentId), actor);
      const now = clock();
      // This actor's own entry is read first, so that arriving again while still present keeps the
      // instant of the actual arrival: "editing since" is what an entry is read for, and an entry that
      // reset it every few seconds would answer "editing since a moment ago" forever. An entry that had
      // already run out is a return rather than a refresh, so it arrives now. The read and the write are
      // two operations and a second enter by this same actor could land between them — which costs at
      // most a stale `enteredAt` on that actor's own row, because there is nothing here to win.
      const standing = await collection().findOne({ _id: key, expiresAt: { $gt: now } });
      const entry = graded(
        {
          contentId,
          actor,
          enteredAt: standing === null ? now : entryFrom(standing).enteredAt,
          heartbeatAt: now,
          expiresAt: presenceExpiry(now, presenceMs),
        },
        'this is not an entry presence could read back',
      );
      const document = await collection().findOneAndUpdate({ _id: key }, { $set: { ...entry } }, {
        upsert: true,
        returnDocument: 'after',
      });
      return entryFrom(document);
    },

    async list(context, contentId) {
      permit(context, 'read');
      const rows = await collection()
        .find(livingFilter(checkContentId(contentId), clock()), { sort: { enteredAt: 1 } })
        .toArray();
      return Object.freeze(rows.map((row) => entryFrom(row)));
    },

    async leave(context, { contentId }) {
      const { actor } = permit(context, 'enter');
      const key = presenceKey(checkContentId(contentId), actor);
      const { deletedCount } = await collection().deleteOne({ _id: key });
      return deletedCount === 1;
    },
  };
  return Object.freeze(store);
}

/**
 * The driver satisfies this interface in practice; the cast is about the document types the driver
 * reports, which nothing here reads back except through `entryFrom`.
 */
export function presenceDb(db: Db): PresenceDb {
  return { collection: (name) => db.collection(name) as unknown as PresenceCollection };
}
