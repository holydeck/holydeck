// Where a session lives while it is a session: server-side, keyed by a digest of an identifier this
// store never keeps a copy of, in a collection of its own.
//
// Sessions are operational state, not history, so they do not go through the repositories in records.ts —
// that layer has no update or delete verb on purpose (ADR 0009), and a session is refreshed, rotated and
// ended. The queue took the same road for the same reason, and this module follows it: one collection,
// its own permissions, its own privileges, its own declared indexes.
//
// One document is one browser-container, not one session: a browser can hold several authenticated
// account slots at once, and exactly one of them is `active`. Every downstream reader — `csrf.ts`,
// `authorization.ts`, `live.ts`, both session routes — keeps believing it is talking to one session,
// because from its point of view it is: the active slot's own `SessionRecord`-shaped fields, and nothing
// of any sibling slot beyond what `slots()` deliberately redacts to `{slotId, actor}`.
//
// Two things are deliberately not here. Nothing generates a slot's claims: what an actor may do arrives
// from whoever authenticated them and is written down as it was given. And nothing reads a claim out of
// an identifier, because there is nothing in one to read — an identifier is 32 bytes of randomness, and
// every question about who it belongs to is answered by looking it up here.

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
import { droppedIndex } from './repositories.js';

import type { SessionRecord, SessionRotation, SlotSummary } from '@holydeck/contracts/sessions';
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

// The expiry index is what makes a container that is over stop existing rather than stop working: a
// record nothing reads is still a record a stolen backup contains. It reads `expiresOn`, the max of every
// slot's own deadline, written a second time as an instant because an expiry index cannot read text. The
// actor index is a multikey index into `slots`, which is what lets `revokeAllFor` be a query and not a
// scan across every browser-container a deployment holds.
const DECLARED_INDEXES: readonly SessionIndex[] = [
  { name: 'session_actor', keys: { 'slots.actor': 1 }, options: {} },
  { name: 'session_expiry', keys: { expiresOn: 1 }, options: { expireAfterSeconds: 0 } },
];

export const SESSION_INDEXES = Object.freeze(DECLARED_INDEXES);

/** Every field this store's documents carry, for the index guard below: the container's own, and a slot's. */
const CARRIED = new Set<string>(['_id', 'active', 'expiresOn', 'tickets', ...SESSION_FIELDS.map((field) => `slots.${field}`)]);

export type SessionRefusal = 'context' | 'permission' | 'schema' | 'unknown' | 'expired' | 'ticket' | 'slot';

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
  updateMany(filter: Filter, update: Document): Promise<{ modifiedCount: number }>;
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

/** One authenticated account, inside one browser-container. Exactly a `SessionRecord`'s fields, plus its id. */
interface StoredSlot {
  readonly slotId: string;
  readonly actor: string;
  readonly permissions: readonly string[];
  readonly startedAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
  readonly rotation: SessionRotation;
  readonly csrf: string;
}

/** A ticket names the slot that was active when it was minted, not whichever slot is active when it is spent. */
interface StoredTicket {
  readonly hash: string;
  readonly expiresAt: string;
  readonly slotId: string;
}

const HOUR_MS = 3_600_000;

const after = (instant: string, milliseconds: number): string =>
  new Date(Date.parse(instant) + milliseconds).toISOString();

/**
 * Grades a session record against the contract. Used on the way in and on the way out: a slot this store
 * would not read back is one it will not write, and a slot it cannot read is not one to hand a caller.
 */
function grade(candidate: unknown, complaint: string): SessionRecord {
  const parsed = parseSessionRecord(candidate);
  if (!parsed.ok) {
    throw new SessionError('schema', `${complaint}: ${parsed.problems.map((p) => `${p.path} ${p.message}`).join('; ')}`);
  }
  return parsed.value;
}

/**
 * A stored slot, graded the same way a session record is. `slotId` rides alongside the fields `grade`
 * reads — the contract's parser reads only the fields it names and drops the rest, so the same call
 * validates every `SessionRecord`-shaped field while this reads `slotId` back off the same candidate.
 */
function gradeSlot(candidate: unknown): StoredSlot {
  const record = grade(candidate, 'the store holds a slot this code cannot read');
  const slotId = String((candidate as Record<string, unknown> | null)?.['slotId'] ?? '');
  return { slotId, ...record };
}

/** A slot's `SessionRecord`-shaped fields, which is the whole of what a caller reading `active` ever sees. */
const recordOf = (slot: StoredSlot): SessionRecord => ({
  actor: slot.actor,
  permissions: slot.permissions,
  startedAt: slot.startedAt,
  lastSeenAt: slot.lastSeenAt,
  expiresAt: slot.expiresAt,
  rotation: slot.rotation,
  csrf: slot.csrf,
});

/** A slot as the database keeps it: the same fields, plus its own identifier, plus a mutable permissions copy. */
const slotDocument = (slot: StoredSlot): Document => ({
  slotId: slot.slotId,
  actor: slot.actor,
  permissions: [...slot.permissions],
  startedAt: slot.startedAt,
  lastSeenAt: slot.lastSeenAt,
  expiresAt: slot.expiresAt,
  rotation: slot.rotation,
  csrf: slot.csrf,
});

/** A brand-new container, holding exactly the one slot it was opened with. */
const containerFor = (token: string, slot: StoredSlot): Document => ({
  _id: tokenDigest(token),
  active: slot.slotId,
  slots: [slotDocument(slot)],
  expiresOn: new Date(slot.expiresAt),
  tickets: [],
});

/** Every slot a stored container document carries, graded the way a slot read out of it must be. */
const slotsFrom = (document: Document): StoredSlot[] =>
  ((document['slots'] ?? []) as readonly unknown[]).map((entry) => gradeSlot(entry));

/** The container's own deadline: the latest of its slots', because the container survives as long as one does. */
const maxExpiry = (slots: readonly StoredSlot[]): Date =>
  new Date(Math.max(...slots.map((slot) => Date.parse(slot.expiresAt))));

/** Which idle sibling a container falls back to when the slot it was pointed at is the one that went. */
const mostRecentlySeen = (slots: readonly StoredSlot[]): StoredSlot =>
  [...slots].sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt))[0] as StoredSlot;

export interface StartedSession {
  readonly joined: boolean;
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
    /** The container token this request already carried, if any. Absent, unknown or fully-expired all fall
     *  back to opening fresh, silently — a stale cookie is never a caller-visible failure. Live: the slot
     *  joins that same container instead of opening a new one. */
    join?: string,
  ): Promise<StartedSession>;
  read(context: unknown, token: string): Promise<SessionRecord>;
  /** Makes `slotId` the container's active slot. Refuses with `'slot'` when no slot in it carries that id. */
  activate(context: unknown, token: string, slotId: string): Promise<SessionRecord>;
  /** Every slot this container holds, redacted to what one slot may know about another: which one, and who. */
  slots(context: unknown, token: string): Promise<readonly SlotSummary[]>;
  rotate(
    context: unknown,
    token: string,
    input: { readonly rotation: SessionRotation; readonly permissions?: readonly string[] },
  ): Promise<StartedSession>;
  /** Ends the whole container — every slot at once. There is no per-slot sign-out. */
  revoke(context: unknown, token: string): Promise<boolean>;
  revokeAllFor(context: unknown, actor: string): Promise<number>;
  /**
   * Ends every session this deployment holds, and answers how many containers that was. Restoring a
   * backup is what this exists for: the archive deliberately carries no session, so a restore puts back a
   * world every open session predates without ending any of them. Whole containers, not per-actor —
   * afterwards nobody is signed in, which is the only safe thing to be sure of about who was.
   */
  revokeEvery(context: unknown): Promise<number>;
  issueTicket(context: unknown, token: string): Promise<string>;
  redeemTicket(context: unknown, token: string, ticket: string): Promise<SessionRecord>;
}

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

  const newSlot = (
    actor: string,
    permissions: readonly string[],
    now: string,
    slotId: string = newToken(),
  ): StoredSlot => ({
    slotId,
    ...grade(
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
    ),
  });

  interface LoadedContainer {
    readonly id: string;
    /** Every slot left once the ones past their deadline are dropped. Never empty — that throws instead. */
    readonly slots: readonly StoredSlot[];
    /** The slot this call resolves against: the one asked for, or the most recently seen if that one went. */
    readonly active: StoredSlot;
  }

  /**
   * The container an identifier stands for, or a refusal saying which of the two things went wrong. Every
   * slot whose own window is over is dropped on the way past — a sibling gone idle never takes the rest of
   * the container down with it, and if the slot a caller was pointed at is the one that went, the most
   * recently seen survivor is silently promoted in its place. Only when nothing is left does this throw:
   * the container is then removed, and the caller is genuinely signed out of everything.
   */
  const load = async (
    rows: SessionCollection,
    token: string,
    now: string,
    touch?: (active: StoredSlot) => Partial<StoredSlot>,
  ): Promise<LoadedContainer> => {
    const id = tokenDigest(token);
    const document = await rows.findOne({ _id: id });
    // Nothing of the identifier is repeated back: a refusal that quotes it is a refusal that logs it.
    if (document === null) throw new SessionError('unknown', 'there is no session with that identifier');
    const all = slotsFrom(document);
    const alive = all.filter((slot) => sessionState(recordOf(slot), now) === 'active');
    if (alive.length === 0) {
      await rows.deleteOne({ _id: id });
      throw new SessionError('expired', 'the session is over and has been ended');
    }
    const requested = String(document['active']);
    const settled = alive.find((slot) => slot.slotId === requested) ?? mostRecentlySeen(alive);
    const active = touch === undefined ? settled : { ...settled, ...touch(settled) };
    const nextSlots = alive.map((slot) => (slot.slotId === settled.slotId ? active : slot));
    // A prune, a promotion, or a caller's own touch all leave the stored document behind what was just
    // read — persisted here, in the one write this already makes, so it is not silently rediscovered later.
    const changed = alive.length !== all.length || settled.slotId !== requested || touch !== undefined;
    if (changed) {
      await rows.updateOne(
        { _id: id },
        { $set: { active: active.slotId, slots: nextSlots.map(slotDocument), expiresOn: maxExpiry(nextSlots) } },
      );
    }
    return { id, slots: nextSlots, active };
  };

  /** A container to join, its expired slots already dropped — or nothing, when a join token is not one. */
  const liveContainer = async (
    rows: SessionCollection,
    token: string,
    now: string,
  ): Promise<{ readonly id: string; readonly slots: readonly StoredSlot[] } | undefined> => {
    const id = tokenDigest(token);
    const document = await rows.findOne({ _id: id });
    if (document === null) return undefined;
    const alive = slotsFrom(document).filter((slot) => sessionState(recordOf(slot), now) === 'active');
    return alive.length === 0 ? undefined : { id, slots: alive };
  };

  const store: SessionStore = {
    async start(context, { actor, permissions }, join) {
      permit(context, 'start');
      const rows = db.collection(SESSIONS_COLLECTION);
      const now = options.now();
      const container = join === undefined ? undefined : await liveContainer(rows, join, now);
      if (container === undefined) {
        const slot = newSlot(actor, permissions, now);
        const token = newToken();
        await rows.insertOne(containerFor(token, slot));
        return { token, record: recordOf(slot), joined: false };
      } else {
        // Re-signing in as an account already holding a slot here replaces it in place, so re-authenticating
        // never accumulates stale duplicates of the same actor's slot.
        const existing = container.slots.find((candidate) => candidate.actor === actor);
        const slot = newSlot(actor, permissions, now, existing?.slotId);
        const nextSlots =
          existing === undefined
            ? [...container.slots, slot]
            : container.slots.map((candidate) => (candidate.slotId === slot.slotId ? slot : candidate));
        const token = newToken();
        await rows.deleteOne({ _id: container.id });
        await rows.insertOne({
          _id: tokenDigest(token),
          active: slot.slotId,
          slots: nextSlots.map(slotDocument),
          expiresOn: maxExpiry(nextSlots),
          tickets: [],
        });
        return { token, record: recordOf(slot), joined: true };
      }
    },

    async read(context, token) {
      permit(context, 'read');
      const rows = db.collection(SESSIONS_COLLECTION);
      const now = options.now();
      // Being used is what keeps a slot inside its idle window. The absolute deadline is untouched.
      const { active } = await load(rows, token, now, () => ({ lastSeenAt: now }));
      return recordOf(active);
    },

    async activate(context, token, slotId) {
      permit(context, 'read');
      const rows = db.collection(SESSIONS_COLLECTION);
      const now = options.now();
      const { id, slots } = await load(rows, token, now);
      const target = slots.find((slot) => slot.slotId === slotId);
      if (target === undefined) {
        throw new SessionError('slot', 'no slot with that identifier in this session');
      }
      const touched = { ...target, lastSeenAt: now };
      const nextSlots = slots.map((slot) => (slot.slotId === touched.slotId ? touched : slot));
      await rows.updateOne(
        { _id: id },
        { $set: { active: touched.slotId, slots: nextSlots.map(slotDocument), expiresOn: maxExpiry(nextSlots) } },
      );
      return recordOf(touched);
    },

    async slots(context, token) {
      permit(context, 'read');
      const rows = db.collection(SESSIONS_COLLECTION);
      const now = options.now();
      const { slots } = await load(rows, token, now);
      return slots.map((slot) => Object.freeze({ slotId: slot.slotId, actor: slot.actor }));
    },

    async rotate(context, token, { rotation, permissions }) {
      permit(context, 'start');
      permit(context, 'end');
      const rows = db.collection(SESSIONS_COLLECTION);
      const now = options.now();
      const { id, slots, active } = await load(rows, token, now);
      const graded: StoredSlot = {
        slotId: active.slotId,
        ...grade(
          {
            ...recordOf(active),
            permissions: [...(permissions ?? active.permissions)],
            lastSeenAt: now,
            rotation,
            csrf: newToken(),
          },
          'a rotated session this store would not read back',
        ),
      };
      const nextSlots = slots.map((slot) => (slot.slotId === graded.slotId ? graded : slot));
      const fresh = newToken();
      // The old identifier stops working first. If the write that follows it fails, the operator signs in
      // again, which is the half of that failure worth having.
      await rows.deleteOne({ _id: id });
      await rows.insertOne({
        _id: tokenDigest(fresh),
        active: graded.slotId,
        slots: nextSlots.map(slotDocument),
        expiresOn: maxExpiry(nextSlots),
        tickets: [],
      });
      return { token: fresh, record: recordOf(graded), joined: false };
    },

    async revoke(context, token) {
      permit(context, 'end');
      const { deletedCount } = await db.collection(SESSIONS_COLLECTION).deleteOne({ _id: tokenDigest(token) });
      return deletedCount === 1;
    },

    async revokeAllFor(context, actor) {
      permit(context, 'end');
      const rows = db.collection(SESSIONS_COLLECTION);
      // Pulled from every container that actor holds a slot in, not deleted whole: a sibling actor's own
      // slot in the same container survives. A container left with none is then cleaned up in its own step.
      const pulled = await rows.updateMany({ 'slots.actor': actor }, { $pull: { slots: { actor } } });
      await rows.deleteMany({ slots: { $size: 0 } });
      return pulled.modifiedCount;
    },

    async revokeEvery(context) {
      permit(context, 'end');
      const { deletedCount } = await db.collection(SESSIONS_COLLECTION).deleteMany({});
      return deletedCount;
    },

    async issueTicket(context, token) {
      permit(context, 'read');
      const rows = db.collection(SESSIONS_COLLECTION);
      const now = options.now();
      const { id, active } = await load(rows, token, now);
      const ticket = newToken();
      // Names the slot that was active at the moment this was minted — not whichever slot is active when
      // it is later spent, which is what stops a switch from carrying a run to a slot it was never issued to.
      const held: StoredTicket = {
        hash: tokenDigest(ticket),
        expiresAt: after(now, TICKET_SECONDS * 1000),
        slotId: active.slotId,
      };
      await rows.updateOne({ _id: id }, { $push: { tickets: { $each: [held], $slice: -MAX_TICKETS } } });
      return ticket;
    },

    async redeemTicket(context, token, ticket) {
      permit(context, 'read');
      const rows = db.collection(SESSIONS_COLLECTION);
      const now = options.now();
      const { slots } = await load(rows, token, now);
      const hash = tokenDigest(ticket);
      // Taken out of the container in the same operation that finds it, so two sockets racing on one ticket
      // are one socket that opened and one that did not. A ticket past its seconds is taken out too.
      const before = await rows.findOneAndUpdate(
        { _id: tokenDigest(token), 'tickets.hash': hash },
        { $pull: { tickets: { hash } } },
        { returnDocument: 'before' },
      );
      const outstanding = before === null ? [] : (before['tickets'] as readonly StoredTicket[]);
      const held = outstanding.find((candidate) => candidate.hash === hash);
      if (held === undefined || Date.parse(held.expiresAt) <= Date.parse(now)) {
        throw new SessionError('ticket', 'a handshake ticket opens one socket, within the seconds it is good for');
      }
      // Resolved against the slot the ticket names, never whatever slot happens to be active at redemption:
      // a switch in between must never let the ticket resolve to a slot it was not issued to.
      const owner = slots.find((slot) => slot.slotId === held.slotId);
      if (owner === undefined) {
        throw new SessionError('ticket', 'a handshake ticket opens one socket, within the seconds it is good for');
      }
      return recordOf(owner);
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
  return droppedIndex(() => db.collection(SESSIONS_COLLECTION).dropIndex(name));
}

/**
 * The driver satisfies this interface in practice; the cast is about the document types the driver reports,
 * which nothing here reads back except through `slotsFrom`.
 */
export function sessionDb(db: Db): SessionDb {
  return { collection: (name) => db.collection(name) as unknown as SessionCollection };
}
