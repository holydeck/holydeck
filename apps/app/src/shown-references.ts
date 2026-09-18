// Which reference an operator explicitly put in front of the room, and which corpus revision it was read
// at (spec BIBL-04, the recording half of fast live lookup).
//
// This is NOT the presentation-run log, and nothing here should be read as if it were. Plan tasks T76-T79
// (LIVE-01 through LIVE-12) build that: a server-authoritative run lifecycle whose event log is immutable
// under ADR 0002 and ADR 0007, carries actor, time and pinned revision on every state change, and
// reconstructs a run exactly. This store makes none of those promises. It does not claim mutation-proof
// storage, it is never read to rebuild a run, it has no retention class, and it knows nothing about runs,
// sessions or services at all — it holds one row per explicit show and that is the whole of it. It exists
// so that BIBL-04's "the revision that was displayed is recorded" is true today rather than deferred, and
// it is deliberately narrow enough that T79 can migrate or drop what it holds in one pass.
//
// Non-entity, the same as presence.ts and translation-offsets.ts: these rows are the operational history
// of one operator surface, not content with a revision history, so they do not go through the repositories
// in records.ts (ADR 0009). Append-only by omission rather than by policy — `record` and `recent` are the
// only verbs, and there is nothing here that changes or removes a row that was written, which is the
// strongest statement a store this provisional is entitled to make.
//
// No index is declared. The one read is the most recent few rows, and declaring an index this deployment
// has no migration to build would be a promise made in a file that cannot keep it; the real log declares
// its own when T79 builds it.

import { randomBytes } from 'node:crypto';

import { contextProblems, requestContext } from './context.js';

import type { RequestContext } from './context.js';
import type { Db } from 'mongodb';
import type { Document, Filter, ReadOptions } from './repositories.js';

export const SHOWN_REFERENCE_COLLECTION = 'shown_references';

/** What an actor needs to reach the log. Adding to it is an operator's; reading it back is inspection. */
export const SHOWN_REFERENCE_PERMISSIONS = Object.freeze({
  record: 'shownReferences.record',
  read: 'shownReferences.read',
} as const);

export type ShownReferenceNeed = keyof typeof SHOWN_REFERENCE_PERMISSIONS;

export type ShownReferenceRefusal = 'context' | 'permission' | 'schema';

/** Carries why the call was refused. */
export class ShownReferenceError extends Error {
  readonly kind: ShownReferenceRefusal;

  constructor(kind: ShownReferenceRefusal, message: string) {
    super(message);
    this.name = 'ShownReferenceError';
    this.kind = kind;
  }
}

/** The reference that was shown, without the revision: that is recorded from what the library answered. */
export interface ShownReferenceSelection {
  readonly abbr: string;
  readonly book: string;
  readonly chapter: number;
  readonly verses: readonly number[];
}

export interface ShownReference {
  readonly reference: ShownReferenceSelection;
  /** The corpus revision the verses were actually read at, never one a caller asked for and did not get. */
  readonly revision: number;
  readonly actor: string;
  readonly recordedAt: string;
}

/** The slice of a Mongo collection this store uses. Narrow on purpose: a test can supply all of it. */
export interface ShownReferenceCollection {
  insertOne(document: Document): Promise<{ insertedId: unknown }>;
  find(filter: Filter, options?: ReadOptions): { toArray(): Promise<Document[]> };
}

export interface ShownReferenceDb {
  collection(name: string): ShownReferenceCollection;
}

/** The context an operator reaches the log under: themselves, allowed to add to it and to read it back. */
export function shownReferenceContext(actor: string, correlationId: string): RequestContext {
  return requestContext({
    actor,
    permissions: Object.values(SHOWN_REFERENCE_PERMISSIONS),
    correlationId,
  });
}

// The log is ordered by `recordedAt`, and Mongo compares it as text — which is the ordering of the instants
// it names only while every one of them is written the same way. A clock writing them any other way is
// refused here rather than producing a log that reads back in an order nothing was shown in.
const CANONICAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** How many entries a read answers with when the caller named no number of its own. */
export const DEFAULT_SHOWN_LIMIT = 50;

const SHOWN_ID_BYTES = 16;

const refuse = (message: string): never => {
  throw new ShownReferenceError('schema', `shownReferences: ${message}`);
};

const checkedReference = (reference: ShownReferenceSelection): ShownReferenceSelection => {
  if (typeof reference.abbr !== 'string' || reference.abbr.trim() === '') refuse('a reference names no translation');
  if (typeof reference.book !== 'string' || reference.book.trim() === '') refuse('a reference names no book');
  if (!Number.isInteger(reference.chapter) || reference.chapter < 1) refuse('a reference names no chapter');
  if (!Array.isArray(reference.verses) || reference.verses.length === 0) refuse('a reference names no verse');
  if (reference.verses.some((verse) => !Number.isInteger(verse) || verse < 1)) refuse('a reference names no verse');
  return {
    abbr: reference.abbr,
    book: reference.book,
    chapter: reference.chapter,
    verses: Object.freeze([...reference.verses]),
  };
};

const checkedRevision = (revision: number): number => {
  if (!Number.isInteger(revision) || revision < 1) refuse('a library holds no revision below the first one');
  return revision;
};

const checkedTime = (recordedAt: string): string => {
  if (!CANONICAL_TIME.test(recordedAt)) {
    refuse(`the log is ordered as text, so ${recordedAt} has to be an instant in UTC written with milliseconds`);
  }
  return recordedAt;
};

/** Grades a stored row on the way out, so an entry this code cannot read is never served as one it can. */
export function entryFrom(document: Document): ShownReference {
  const { abbr, book, chapter, verses, revision, actor, recordedAt } = document;
  if (typeof actor !== 'string' || actor.trim() === '') refuse('the log holds an entry naming nobody');
  if (typeof revision !== 'number') refuse('the log holds an entry with no revision this code can read');
  if (typeof recordedAt !== 'string') refuse('the log holds an entry with no instant this code can read');
  return Object.freeze({
    reference: checkedReference({
      abbr: abbr as string,
      book: book as string,
      chapter: chapter as number,
      verses: verses as readonly number[],
    }),
    revision: checkedRevision(revision as number),
    actor: actor as string,
    recordedAt: checkedTime(recordedAt as string),
  });
}

export interface ShownReferenceOptions {
  /** Injected so a test can pin an instant, and so every row in one log comes from one clock. */
  readonly now: () => string;
  readonly newId?: () => string;
}

export interface ShownReferenceInput {
  readonly reference: ShownReferenceSelection;
  readonly revision: number;
}

export interface ShownReferenceStore {
  /**
   * Writes down one reference an operator explicitly showed, at the revision the library answered with.
   * The actor is the one in the context, never one the caller passed alongside it.
   */
  record(context: unknown, input: ShownReferenceInput): Promise<ShownReference>;
  /** The most recently shown first. Reading the log is not showing anything, and records nothing. */
  recent(context: unknown, limit?: number): Promise<readonly ShownReference[]>;
}

/** The log over one database. Nothing here reads an ambient clock, database or current user. */
export function shownReferencesOn(db: ShownReferenceDb, options: ShownReferenceOptions): ShownReferenceStore {
  const rows = (): ShownReferenceCollection => db.collection(SHOWN_REFERENCE_COLLECTION);
  const newId = options.newId ?? ((): string => randomBytes(SHOWN_ID_BYTES).toString('base64url'));

  const permit = (context: unknown, need: ShownReferenceNeed): RequestContext => {
    const problems = contextProblems(context);
    if (problems.length > 0) throw new ShownReferenceError('context', `shownReferences: ${problems.join('; ')}`);
    const permission = SHOWN_REFERENCE_PERMISSIONS[need];
    if (!(context as RequestContext).permissions.includes(permission)) {
      throw new ShownReferenceError(
        'permission',
        `shownReferences: the actor may not ${need} what was shown, which needs ${permission}`,
      );
    }
    return context as RequestContext;
  };

  const store: ShownReferenceStore = {
    async record(context, input) {
      const { actor } = permit(context, 'record');
      const entry: ShownReference = {
        reference: checkedReference(input.reference),
        revision: checkedRevision(input.revision),
        actor,
        recordedAt: checkedTime(options.now()),
      };
      await rows().insertOne({ _id: newId(), ...entry.reference, revision: entry.revision, actor, recordedAt: entry.recordedAt });
      return Object.freeze(entry);
    },

    async recent(context, limit = DEFAULT_SHOWN_LIMIT) {
      permit(context, 'read');
      const found = await rows().find({}, { sort: { recordedAt: -1 }, limit }).toArray();
      return Object.freeze(found.map((row) => entryFrom(row)));
    },
  };
  return Object.freeze(store);
}

/**
 * The driver satisfies this interface in practice; the cast is about the document types the driver
 * reports, which nothing here reads back except through `entryFrom`.
 */
export function shownReferenceDb(db: Db): ShownReferenceDb {
  return { collection: (name) => db.collection(name) as unknown as ShownReferenceCollection };
}
