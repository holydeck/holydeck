// A per-translation offset, inspectable and configurable, applied to a chapter before it is asked for
// (spec BIBL-02).
//
// Narrow and non-entity, the same as presence.ts: an offset is operational configuration, not content
// with a history, so it does not go through the repositories in records.ts (ADR 0009). Reading one back —
// or every one configured — is not a change and asks for nothing; only setting one is, which is why this
// store's own permissions gate `set` alone. Keyed by translation abbreviation, so there is at most one
// offset per translation and setting one is an upsert.
//
// No index beyond Mongo's own `_id` index is declared: every read here is either by that key or unfiltered
// across the whole collection, and a deployment holds at most a handful of translations.

import { contextProblems, requestContext } from './context.js';

import type { RequestContext } from './context.js';
import type { Db } from 'mongodb';
import type { Document, Filter } from './repositories.js';

export const TRANSLATION_OFFSET_COLLECTION = 'translation_offsets';

/** What an actor needs to change an offset. Reading one back, or every one configured, asks for nothing. */
export const TRANSLATION_OFFSET_PERMISSIONS = Object.freeze({
  manage: 'translationOffsets.manage',
} as const);

export type TranslationOffsetNeed = keyof typeof TRANSLATION_OFFSET_PERMISSIONS;

export type TranslationOffsetRefusal = 'context' | 'permission' | 'schema';

/** Carries why the call was refused. */
export class TranslationOffsetError extends Error {
  readonly kind: TranslationOffsetRefusal;

  constructor(kind: TranslationOffsetRefusal, message: string) {
    super(message);
    this.name = 'TranslationOffsetError';
    this.kind = kind;
  }
}

export interface TranslationOffsetEntry {
  readonly abbr: string;
  readonly offset: number;
}

/** The slice of a Mongo collection this store uses. Narrow on purpose: a test can supply all of it. */
export interface TranslationOffsetCollection {
  findOne(filter: Filter): Promise<Document | null>;
  find(filter: Filter): { toArray(): Promise<Document[]> };
  findOneAndUpdate(
    filter: Filter,
    update: Document,
    options: { readonly upsert: true; readonly returnDocument: 'after' },
  ): Promise<Document>;
}

export interface TranslationOffsetDb {
  collection(name: string): TranslationOffsetCollection;
}

/** The context the server reaches its own store under: itself, allowed to set an offset. */
export function translationOffsetSystemContext(correlationId: string): RequestContext {
  return requestContext({
    actor: 'system',
    permissions: Object.values(TRANSLATION_OFFSET_PERMISSIONS),
    correlationId,
  });
}

const checkAbbr = (abbr: string): string => {
  if (abbr.trim() === '') {
    throw new TranslationOffsetError('schema', 'translationOffsets: a translation abbreviation cannot be blank');
  }
  return abbr;
};

const checkOffset = (offset: number): number => {
  if (!Number.isInteger(offset)) {
    throw new TranslationOffsetError('schema', 'translationOffsets: an offset is a whole number of chapters');
  }
  return offset;
};

const entryFrom = (document: Document): TranslationOffsetEntry => ({
  abbr: String(document['_id']),
  offset: Number(document['offset']),
});

export interface TranslationOffsetStore {
  /** The configured offset for this translation, or zero when none has ever been set. Asks for nothing. */
  get(abbr: string): Promise<number>;
  /** Every translation an offset has been configured for — inspectable, not a default for the rest. */
  list(): Promise<readonly TranslationOffsetEntry[]>;
  /** Upserts the offset for this translation. May be negative, zero, or positive. */
  set(context: unknown, abbr: string, offset: number): Promise<TranslationOffsetEntry>;
}

/** The store over one database. Nothing here reads an ambient clock, database or current user. */
export function translationOffsetsOn(db: TranslationOffsetDb): TranslationOffsetStore {
  const rows = (): TranslationOffsetCollection => db.collection(TRANSLATION_OFFSET_COLLECTION);

  const permit = (context: unknown, need: TranslationOffsetNeed): void => {
    const problems = contextProblems(context);
    if (problems.length > 0) throw new TranslationOffsetError('context', `translationOffsets: ${problems.join('; ')}`);
    const permission = TRANSLATION_OFFSET_PERMISSIONS[need];
    if (!(context as RequestContext).permissions.includes(permission)) {
      throw new TranslationOffsetError(
        'permission',
        `translationOffsets: the actor may not ${need} an offset, which needs ${permission}`,
      );
    }
  };

  const store: TranslationOffsetStore = {
    async get(abbr) {
      const document = await rows().findOne({ _id: abbr });
      return document === null ? 0 : entryFrom(document).offset;
    },

    async list() {
      const documents = await rows().find({}).toArray();
      return Object.freeze(documents.map((document) => entryFrom(document)));
    },

    async set(context, abbr, offset) {
      permit(context, 'manage');
      const key = checkAbbr(abbr);
      checkOffset(offset);
      const document = await rows().findOneAndUpdate(
        { _id: key },
        { $set: { offset } },
        { upsert: true, returnDocument: 'after' },
      );
      return entryFrom(document);
    },
  };
  return Object.freeze(store);
}

/**
 * The driver satisfies this interface in practice; the cast is about the document types the driver
 * reports.
 */
export function translationOffsetDb(db: Db): TranslationOffsetDb {
  return { collection: (name) => db.collection(name) as unknown as TranslationOffsetCollection };
}
