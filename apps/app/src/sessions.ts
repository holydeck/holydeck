// Where a session lives while it is a session: server-side, keyed by a digest of an identifier this
// store never keeps a copy of, in a collection of its own.
//
// Sessions are operational state, not history, so they do not go through the repositories in records.ts —
// that layer has no update or delete verb on purpose (ADR 0009), and a session is refreshed, rotated and
// ended. The queue took the same road for the same reason, and this module follows it: one collection,
// its own permissions, its own privileges, its own declared indexes.
//
// Two things are deliberately not here. Nothing generates a session's claims: what an actor may do arrives
// from whoever authenticated them and is written down as it was given. And nothing reads a claim out of an
// identifier, because there is nothing in one to read — an identifier is 32 bytes of randomness, and every
// question about who it belongs to is answered by looking it up here.

import { createHash, randomBytes } from 'node:crypto';

import {
  SESSION_ABSOLUTE_HOURS,
  SESSION_FIELDS,
  SESSION_TOKEN_BYTES,
  TICKET_SECONDS,
  parseSessionRecord,
  sessionState,
} from '@holydeck/contracts/sessions';

import { contextProblems, requestContext } from './context.js';

import type { SessionRecord, SessionRotation } from '@holydeck/contracts/sessions';
import type { Db } from 'mongodb';

import type { RequestContext } from './context.js';
import type { Document, Filter } from './repositories.js';

export const SESSIONS_COLLECTION = 'sessions';

/** What an actor needs to reach the store. Starting a session is authentication's; ending one is a sign-out's. */
export const SESSION_PERMISSIONS = Object.freeze({
  start: 'sessions.start',
  read: 'sessions.read',
  end: 'sessions.end',
} as const);

export type SessionNeed = keyof typeof SESSION_PERMISSIONS;

/**
 * The database privileges this collection needs. A durable record class is granted no way to change or
 * remove one (records.ts), which is what makes append-only the database's rule; a session is the opposite
 * kind of thing, and saying so here keeps a deployment from granting the wider set to everything at once.
 */
export const SESSION_ACTIONS: readonly string[] = Object.freeze([
  'createIndex',
  'dropIndex',
  'find',
  'insert',
  'listIndexes',
  'remove',
  'update',
]);

export function sessionPrivileges(): { readonly collection: string; readonly actions: readonly string[] } {
  return { collection: SESSIONS_COLLECTION, actions: SESSION_ACTIONS };
}

/** How many handshake tickets one session may have outstanding: an operator screen, an output, and room. */
export const MAX_TICKETS = 4;

export interface SessionIndex {
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

// The expiry index is what makes a session that is over stop existing rather than stop working: a record
// nothing reads is still a record a stolen backup contains. It reads `expiresOn`, which is the absolute
// deadline written a second time as an instant, because an expiry index cannot read text.
const DECLARED_INDEXES: readonly SessionIndex[] = [
  { name: 'session_actor', keys: { actor: 1 }, options: {} },
  { name: 'session_expiry', keys: { expiresOn: 1 }, options: { expireAfterSeconds: 0 } },
];

export const SESSION_INDEXES = Object.freeze(DECLARED_INDEXES);

const CARRIED = new Set<string>([...SESSION_FIELDS, '_id', 'expiresOn', 'tickets']);

export type SessionRefusal = 'context' | 'permission' | 'schema' | 'unknown' | 'expired' | 'ticket';

/** Carries why the call was refused, so a caller can tell a defect from a session that simply ended. */
export class SessionError extends Error {
  readonly kind: SessionRefusal;

  constructor(kind: SessionRefusal, message: string) {
    super(message);
    this.name = 'SessionError';
    this.kind = kind;
  }
}

export interface FoundOptions {
  readonly returnDocument: 'before' | 'after';
}

/** The slice of a Mongo collection the store uses. Narrow on purpose: a test can supply all of it. */
export interface SessionCollection {
  insertOne(document: Document): Promise<{ insertedId: unknown }>;
  findOne(filter: Filter): Promise<Document | null>;
  findOneAndUpdate(filter: Filter, update: Document, options: FoundOptions): Promise<Document | null>;
  updateOne(filter: Filter, update: Document): Promise<{ matchedCount: number }>;
  deleteOne(filter: Filter): Promise<{ deletedCount: number }>;
  deleteMany(filter: Filter): Promise<{ deletedCount: number }>;
  createIndex(keys: Readonly<Record<string, 1 | -1>>, options?: Readonly<Record<string, unknown>>): Promise<string>;
  dropIndex(index: string): Promise<void>;
}

export interface SessionDb {
  collection(name: string): SessionCollection;
}

/** Building an index needs no session verb, so the call asks for none — the same shape the queue uses. */
export interface IndexDb {
  collection(name: string): Pick<SessionCollection, 'createIndex' | 'dropIndex'>;
}

/** The digest an identifier is stored under. A copy of this collection signs nobody in. */
export const tokenDigest = (token: string): string => createHash('sha256').update(token).digest('hex');

/** The context the server reaches its own session store under: itself, allowed to start, read and end one. */
export function sessionContext(correlationId: string): RequestContext {
  return requestContext({
    actor: 'system',
    permissions: Object.values(SESSION_PERMISSIONS),
    correlationId,
  });
}

interface StoredTicket {
  readonly hash: string;
  readonly expiresAt: string;
}

const HOUR_MS = 3_600_000;

const after = (instant: string, milliseconds: number): string =>
  new Date(Date.parse(instant) + milliseconds).toISOString();

/**
 * Grades a session against the contract. Used on the way in and on the way out: a session this store would
 * not read back is one it will not write, and a session it cannot read is not one to hand a caller.
 */
function grade(candidate: unknown, complaint: string): SessionRecord {
  const parsed = parseSessionRecord(candidate);
  if (!parsed.ok) {
    throw new SessionError('schema', `${complaint}: ${parsed.problems.map((p) => `${p.path} ${p.message}`).join('; ')}`);
  }
  return parsed.value;
}

/** What the database keeps for its own purposes: an identifier, a deadline it expires by, and tickets. */
const KEPT_BY_THE_STORE = new Set(['_id', 'expiresOn', 'tickets']);

/** The stored document as a record, without the three fields the database keeps for its own purposes. */
export function sessionFrom(document: Document): SessionRecord {
  const fields = Object.fromEntries(Object.entries(document).filter(([name]) => !KEPT_BY_THE_STORE.has(name)));
  return grade(fields, 'the store holds a session this code cannot read');
}

export interface StartedSession {
  /** The identifier the client is given. It exists in this answer, in a cookie, and nowhere else. */
  readonly token: string;
  readonly record: SessionRecord;
}

export interface SessionOptions {
  /** Injected, so every deadline in one store comes from one clock and a test does not have to wait. */
  readonly now: () => string;
  readonly newToken?: () => string;
}

export interface SessionStore {
  start(
    context: unknown,
    input: { readonly actor: string; readonly permissions: readonly string[] },
  ): Promise<StartedSession>;
  read(context: unknown, token: string): Promise<SessionRecord>;
  rotate(
    context: unknown,
    token: string,
    input: { readonly rotation: SessionRotation; readonly permissions?: readonly string[] },
  ): Promise<StartedSession>;
  revoke(context: unknown, token: string): Promise<boolean>;
  revokeAllFor(context: unknown, actor: string): Promise<number>;
  issueTicket(context: unknown, token: string): Promise<string>;
  redeemTicket(context: unknown, token: string, ticket: string): Promise<SessionRecord>;
}

const documentFor = (token: string, record: SessionRecord): Document => ({
  _id: tokenDigest(token),
  ...record,
  permissions: [...record.permissions],
  expiresOn: new Date(record.expiresAt),
  tickets: [],
});

/** The session store over one database. Nothing here reads an ambient clock, database or current user. */
export function sessionsOn(db: SessionDb, options: SessionOptions): SessionStore {
  const newToken = options.newToken ?? ((): string => randomBytes(SESSION_TOKEN_BYTES).toString('base64url'));

  const permit = (context: unknown, need: SessionNeed): RequestContext => {
    const problems = contextProblems(context);
    if (problems.length > 0) throw new SessionError('context', `sessions: ${problems.join('; ')}`);
    const permission = SESSION_PERMISSIONS[need];
    if (!(context as RequestContext).permissions.includes(permission)) {
      throw new SessionError('permission', `sessions: the actor may not ${need} a session, which needs ${permission}`);
    }
    return context as RequestContext;
  };

  /**
   * The session an identifier stands for, or a refusal saying which of the two things went wrong. A session
   * that is over is removed on the way past: the next request for it is then a request for a session that
   * does not exist, which is what it is.
   */
  const load = async (
    rows: SessionCollection,
    token: string,
    now: string,
  ): Promise<{ readonly id: string; readonly record: SessionRecord }> => {
    const id = tokenDigest(token);
    const document = await rows.findOne({ _id: id });
    // Nothing of the identifier is repeated back: a refusal that quotes it is a refusal that logs it.
    if (document === null) throw new SessionError('unknown', 'there is no session with that identifier');
    const record = sessionFrom(document);
    if (sessionState(record, now) !== 'active') {
      await rows.deleteOne({ _id: id });
      throw new SessionError('expired', `the session for ${record.actor} is over and has been ended`);
    }
    return { id, record };
  };

  const store: SessionStore = {
    async start(context, { actor, permissions }) {
      permit(context, 'start');
      const rows = db.collection(SESSIONS_COLLECTION);
      const now = options.now();
      const token = newToken();
      const record = grade(
        {
          actor,
          permissions: [...permissions],
          startedAt: now,
          lastSeenAt: now,
          expiresAt: after(now, SESSION_ABSOLUTE_HOURS * HOUR_MS),
          rotation: 'authentication',
          csrf: newToken(),
        },
        'a session this store would not read back',
      );
      await rows.insertOne(documentFor(token, record));
      return { token, record };
    },

    async read(context, token) {
      permit(context, 'read');
      const rows = db.collection(SESSIONS_COLLECTION);
      const now = options.now();
      const { id, record } = await load(rows, token, now);
      // Being used is what keeps a session inside its idle window. The absolute deadline is untouched.
      await rows.updateOne({ _id: id }, { $set: { lastSeenAt: now } });
      return { ...record, lastSeenAt: now };
    },

    async rotate(context, token, { rotation, permissions }) {
      permit(context, 'start');
      permit(context, 'end');
      const rows = db.collection(SESSIONS_COLLECTION);
      const now = options.now();
      const { id, record } = await load(rows, token, now);
      const next = grade(
        {
          ...record,
          permissions: [...(permissions ?? record.permissions)],
          lastSeenAt: now,
          rotation,
          csrf: newToken(),
        },
        'a rotated session this store would not read back',
      );
      const fresh = newToken();
      // The old identifier stops working first. If the write that follows it fails, the operator signs in
      // again, which is the half of that failure worth having.
      await rows.deleteOne({ _id: id });
      await rows.insertOne(documentFor(fresh, next));
      return { token: fresh, record: next };
    },

    async revoke(context, token) {
      permit(context, 'end');
      const { deletedCount } = await db.collection(SESSIONS_COLLECTION).deleteOne({ _id: tokenDigest(token) });
      return deletedCount === 1;
    },

    async revokeAllFor(context, actor) {
      permit(context, 'end');
      const { deletedCount } = await db.collection(SESSIONS_COLLECTION).deleteMany({ actor });
      return deletedCount;
    },

    async issueTicket(context, token) {
      permit(context, 'read');
      const rows = db.collection(SESSIONS_COLLECTION);
      const now = options.now();
      const { id } = await load(rows, token, now);
      const ticket = newToken();
      const held: StoredTicket = { hash: tokenDigest(ticket), expiresAt: after(now, TICKET_SECONDS * 1000) };
      await rows.updateOne(
        { _id: id },
        { $push: { tickets: { $each: [held], $slice: -MAX_TICKETS } } },
      );
      return ticket;
    },

    async redeemTicket(context, token, ticket) {
      permit(context, 'read');
      const rows = db.collection(SESSIONS_COLLECTION);
      const now = options.now();
      const { id, record } = await load(rows, token, now);
      const hash = tokenDigest(ticket);
      // Taken out of the session in the same operation that finds it, so two sockets racing on one ticket
      // are one socket that opened and one that did not. A ticket past its seconds is taken out too.
      const before = await rows.findOneAndUpdate(
        { _id: id, 'tickets.hash': hash },
        { $pull: { tickets: { hash } } },
        { returnDocument: 'before' },
      );
      const outstanding = before === null ? [] : (before['tickets'] as readonly StoredTicket[]);
      const held = outstanding.find((candidate) => candidate.hash === hash);
      if (held === undefined || Date.parse(held.expiresAt) <= Date.parse(now)) {
        throw new SessionError('ticket', 'a handshake ticket opens one socket, within the seconds it is good for');
      }
      return record;
    },
  };
  return Object.freeze(store);
}

const declaredIndex = (name: string): SessionIndex => {
  const index = SESSION_INDEXES.find((candidate) => candidate.name === name);
  if (index === undefined) throw new SessionError('schema', `${name} is not an index the session store declares`);
  return index;
};

export async function createSessionIndexOn(db: IndexDb, index: SessionIndex): Promise<string> {
  declaredIndex(index.name);
  for (const field of Object.keys(index.keys)) {
    if (!CARRIED.has(field)) {
      throw new SessionError('schema', `${index.name}: a session carries no field named ${field}`);
    }
  }
  return db.collection(SESSIONS_COLLECTION).createIndex(index.keys, { name: index.name, ...index.options });
}

export async function dropSessionIndexOn(db: IndexDb, name: string): Promise<void> {
  declaredIndex(name);
  return db.collection(SESSIONS_COLLECTION).dropIndex(name);
}

/**
 * The driver satisfies this interface in practice; the cast is about the document types the driver reports,
 * which nothing here reads back except through `sessionFrom`.
 */
export function sessionDb(db: Db): SessionDb {
  return { collection: (name) => db.collection(name) as unknown as SessionCollection };
}
