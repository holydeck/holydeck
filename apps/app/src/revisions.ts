// The content revision store: the only way a content body becomes history, and the only way history is
// read back (ADR 0001, spec DATA-02).
//
// Three promises are kept here. A save that changed nothing appends nothing, which is decided by comparing
// addresses rather than by comparing objects, so a body written in another key order is the same body. A
// save that changed something appends exactly one revision, keyed by the content and the ordinal, so a
// second revision 3 is a duplicate key the database refuses rather than a rewrite this code has to notice.
// And a restore appends: it reads an earlier body and saves it forward, so the mistake a restore corrects
// is itself recoverable and nothing in history is moved to make room for it.
//
// What is stored is checked on the way in and on the way out. On the way in, a revision this code could
// not read back is refused before it is written. On the way out, every record is re-addressed from its own
// body, so a body changed behind this store's back is found rather than served — which matters because the
// records layer has no update verb at all, so any such change came from outside the product.

import { createHash } from 'node:crypto';

import {
  HASH_ALGORITHM,
  historyProblems,
  parseRevisionRecord,
  revisionAddress,
  revisionBytes,
  revisionKey,
} from '@holydeck/contracts/revisions';

import { permissionsFor } from './records.js';
import { createIndexOn, RepositoryError, repositoriesOn } from './repositories.js';

import type { RevisionBody, RevisionOrigin, RevisionRecord } from '@holydeck/contracts/revisions';

import type { RequestContext } from './context.js';
import type { Document, RepositoryDb } from './repositories.js';

/** The record class this store owns. Named once, because every permission and index reads off it. */
export const REVISION_RECORD = 'contentRevisions';

export const REVISION_PERMISSIONS = permissionsFor(REVISION_RECORD);

export interface RevisionIndex {
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

// One index, and every read this store makes is served by it: the history of one content in order, the
// revision that stands, and one revision by its ordinal. It is unique as well, so the rule that history
// grows by one is the database's a second time over — the first being the key each revision is stored by.
const DECLARED_INDEXES: readonly RevisionIndex[] = [
  { name: 'content_revision', keys: { contentId: 1, revision: 1 }, options: { unique: true } },
];

export const REVISION_INDEXES = Object.freeze(DECLARED_INDEXES);

export type RevisionRefusal = 'schema' | 'missing' | 'conflict' | 'corrupt';

/** Carries why the call was refused, so a caller can tell a defect from a race it lost fairly. */
export class RevisionError extends Error {
  readonly kind: RevisionRefusal;

  constructor(kind: RevisionRefusal, message: string) {
    super(message);
    this.name = 'RevisionError';
    this.kind = kind;
  }
}

const digestOf = (body: RevisionBody): string =>
  createHash(HASH_ALGORITHM).update(revisionBytes(body), 'utf8').digest('hex');

/** The address of a body: the algorithm, and its digest over the canonical bytes of that body. */
export const addressOf = (body: RevisionBody): string => revisionAddress(digestOf(body));

const documentOf = (record: RevisionRecord): Document => ({
  _id: revisionKey(record.contentId, record.revision),
  contentId: record.contentId,
  revision: record.revision,
  hash: record.hash,
  origin: record.origin,
  at: record.at,
  actor: record.actor,
  correlationId: record.correlationId,
  body: record.body,
});

const corrupt = (message: string): RevisionError =>
  new RevisionError('corrupt', `content_revisions: ${message}, which nothing in this product does`);

/**
 * Grades a stored record on the way out. The key is checked against the revision it claims to be and the
 * body against the address it was written under, because both are what a rewritten history would have to
 * get right and neither is something the store itself can get wrong.
 */
function revisionFrom(document: Document): RevisionRecord {
  const { _id: key, ...fields } = document;
  const parsed = parseRevisionRecord(fields);
  if (!parsed.ok) {
    throw corrupt(`holds a revision this code cannot read: ${parsed.problems.map(readable).join('; ')}`);
  }
  const record = parsed.value;
  const own = revisionKey(record.contentId, record.revision);
  if (key !== own) throw corrupt(`holds revision ${own} under the key ${String(key)}`);
  if (record.hash !== addressOf(record.body)) throw corrupt(`${own} no longer addresses its body`);
  return record;
}

const readable = (problem: { readonly path: string; readonly message: string }): string =>
  `${problem.path} ${problem.message}`;

export interface SaveInput {
  readonly contentId: string;
  readonly body: RevisionBody;
  readonly origin: RevisionOrigin;
}

export interface SaveOutcome {
  /** False when the save changed nothing: the revision below is the one that already stood. */
  readonly appended: boolean;
  readonly revision: RevisionRecord;
}

export interface RestoreOutcome extends SaveOutcome {
  /** The ordinal the body came from, which stays in history exactly where it was. */
  readonly from: number;
}

export interface RevisionStore {
  save(context: unknown, input: SaveInput): Promise<SaveOutcome>;
  restore(context: unknown, input: { readonly contentId: string; readonly revision: number }): Promise<RestoreOutcome>;
  current(context: unknown, contentId: string): Promise<RevisionRecord | undefined>;
  read(context: unknown, contentId: string, revision: number): Promise<RevisionRecord | undefined>;
  history(context: unknown, contentId: string): Promise<readonly RevisionRecord[]>;
  count(context: unknown, contentId: string): Promise<number>;
}

export interface RevisionStoreOptions {
  /** Injected so every revision in one store is stamped by one clock, and so a test can pin it. */
  readonly now: () => string;
}

/**
 * Reads the actor out of a context so an append can record who is appending. Nothing is checked here: by
 * the time this runs the repository has already read with this context, and it refuses a context it cannot
 * read as surely as it refuses an actor who may not append. It stays the only authority on both.
 */
function authorOf(context: unknown): Pick<RequestContext, 'actor' | 'correlationId'> {
  const { actor, correlationId } = context as RequestContext;
  return { actor, correlationId };
}

export function revisionsOn(db: RepositoryDb, options: RevisionStoreOptions): RevisionStore {
  const records = repositoriesOn(db)[REVISION_RECORD];

  const one = async (context: unknown, filter: Document, direction: 1 | -1): Promise<RevisionRecord | undefined> => {
    const [found] = await records.read(context, filter, { sort: { revision: direction }, limit: 1 });
    return found === undefined ? undefined : revisionFrom(found);
  };

  const store: RevisionStore = {
    async save(context, input) {
      const standing = await one(context, { contentId: input.contentId }, -1);
      const hash = addressOf(input.body);
      if (standing?.hash === hash) return { appended: false, revision: standing };
      const record = {
        contentId: input.contentId,
        revision: (standing?.revision ?? 0) + 1,
        hash,
        origin: input.origin,
        at: options.now(),
        ...authorOf(context),
        body: input.body,
      };
      // Nothing is written that this store could not read back: a revision it cannot read is a revision
      // its own history reader would later refuse, and refusing now leaves no such record behind.
      const parsed = parseRevisionRecord(record);
      if (!parsed.ok) {
        throw new RevisionError('schema', `a revision is not appendable: ${parsed.problems.map(readable).join('; ')}`);
      }
      try {
        await records.append(context, documentOf(parsed.value));
      } catch (error) {
        if (error instanceof RepositoryError && error.kind === 'duplicate') {
          throw new RevisionError(
            'conflict',
            `revision ${record.revision} of ${record.contentId} was appended by another writer`,
          );
        }
        throw error;
      }
      return { appended: true, revision: parsed.value };
    },

    async restore(context, input) {
      const target = await store.read(context, input.contentId, input.revision);
      if (target === undefined) {
        throw new RevisionError('missing', `${input.contentId} has no revision ${input.revision} to restore`);
      }
      // A restore is what a person did, so it is recorded as the checkpoint it is rather than as a kind of
      // its own; the body it carries says which revision it came back to, and `from` says it out loud.
      const outcome = await store.save(context, {
        contentId: input.contentId,
        body: target.body,
        origin: 'manual-checkpoint',
      });
      return { ...outcome, from: target.revision };
    },

    current(context, contentId) {
      return one(context, { contentId }, -1);
    },

    read(context, contentId, revision) {
      return one(context, { _id: revisionKey(contentId, revision) }, 1);
    },

    async history(context, contentId) {
      const found = await records.read(context, { contentId }, { sort: { revision: 1 } });
      const revisions = found.map(revisionFrom);
      const problems = historyProblems(revisions);
      if (problems.length > 0) throw corrupt(problems.join('; '));
      return revisions;
    },

    count(context, contentId) {
      return records.count(context, { contentId });
    },
  };
  return store;
}

/**
 * Indexes are not revisions: building one changes how history is read, never what it holds, which is why a
 * migration may do it. Only the ones this store declares, so an index nothing reads cannot arrive quietly.
 */
export function createRevisionIndexOn(db: RepositoryDb, index: RevisionIndex): Promise<string> {
  const declared = REVISION_INDEXES.find((candidate) => candidate.name === index.name);
  if (declared === undefined) {
    throw new RevisionError('schema', `${index.name} is not an index the revision store declares`);
  }
  return createIndexOn(db, REVISION_RECORD, index.keys, { name: index.name, ...index.options });
}
