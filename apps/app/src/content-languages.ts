// The persisted content-language registry as it is administered (spec §11.5, SEED-01).
//
// Composed the way `slide-labels.ts` composes: a stamp history, one row per change, `sequence`
// counting from one, the standing stamp being the highest sequence a key has. There is no separately
// versioned body, so there are no revisions here at all — a display name, a script and a fallback
// font are written inline on the same stamped row, exactly as a label's name and shortcut are.
//
// The one real difference is identity. A slide label's id is an opaque token `slideLabelsOn` mints,
// because nothing about a label's own name is stable enough to key it by. A content language's key
// *is* its stable identity — `@holydeck/contracts/layouts`'s `KeyedBinding.languageKey` and
// `@holydeck/contracts/slide-groups`'s `LanguageBlock.languageKey` already reference it as one — so
// this store takes the key as a caller-chosen argument rather than minting a fresh one, and never
// carries a `newId` option at all.
//
// Archiving frees nothing here — a content language has no catalogue-wide conflict rule to free a
// claim from — but `contentLanguage`'s `archive: 'hidden'` policy still means an archived entry stops
// being offered where a language is chosen while every language block already keyed to it keeps
// resolving. Bringing one back is a touch like any other, not a new claim.

import { EntityError, archivedStamp, createdStamp, parseEntityStamp, restoredStamp, touchedStamp } from '@holydeck/contracts/entities';
import { CONTENT_LANGUAGE_KIND, parseContentLanguageDraft } from '@holydeck/contracts/content-languages';

import { requestContext } from './context.js';
import { permissionsFor } from './records.js';
import { RepositoryError, repositoriesOn } from './repositories.js';

import type { ContentLanguageDraft } from '@holydeck/contracts/content-languages';
import type { EntityStamp } from '@holydeck/contracts/entities';

import type { RequestContext } from './context.js';
import type { Document, RepositoryDb } from './repositories.js';

/** The record class the stamps live in. Named once, because the permissions and the index read off it. */
export const CONTENT_LANGUAGE_RECORD = 'contentLanguages';

export const CONTENT_LANGUAGE_PERMISSIONS = permissionsFor(CONTENT_LANGUAGE_RECORD);

/** How a registry entry is named in the audit trail: never as a bare key that could be anything. */
export const subjectFor = (key: string): string => `contentLanguage:${key}`;

export interface ContentLanguageIndex {
  readonly name: string;
  readonly keys: Readonly<Record<string, 1 | -1>>;
  readonly options: Readonly<Record<string, unknown>>;
}

// One index, and it serves the only reads this store makes: the standing stamp of one key, and of
// every key. Unique, so a stamp history growing by one is the database's rule too.
const DECLARED_INDEXES: readonly ContentLanguageIndex[] = [
  { name: 'content_language_stamp', keys: { languageKey: 1, sequence: -1 }, options: { unique: true } },
];

export const CONTENT_LANGUAGE_INDEXES = Object.freeze(DECLARED_INDEXES);

export type ContentLanguageRefusal = 'schema' | 'state' | 'conflict' | 'corrupt';

/** Carries why the call was refused, so a caller can tell a bad payload from a race it lost fairly. */
export class ContentLanguageError extends Error {
  readonly kind: ContentLanguageRefusal;

  constructor(kind: ContentLanguageRefusal, message: string) {
    super(message);
    this.name = 'ContentLanguageError';
    this.kind = kind;
  }
}

/** The one context the registry is administered under: this store's own record class, and nothing else. */
export function contentLanguageContext(actor: string, correlationId: string): RequestContext {
  return requestContext({ actor, permissions: Object.values(CONTENT_LANGUAGE_PERMISSIONS), correlationId });
}

/** One registry entry as it is administered: whether it is offered, and what it says about its script. */
export interface ContentLanguageRecord extends ContentLanguageDraft {
  readonly stamp: EntityStamp;
}

export interface ContentLanguageStore {
  /** Defines a new registry entry under `key`. Refuses a key another writer already stamped. */
  create(context: unknown, key: string, draft: ContentLanguageDraft): Promise<ContentLanguageRecord>;
  get(context: unknown, key: string): Promise<ContentLanguageRecord | undefined>;
  /** Re-saves a registry entry's display name, script or fallback font. The key itself never changes. */
  edit(context: unknown, key: string, draft: ContentLanguageDraft): Promise<ContentLanguageRecord | undefined>;
  /** Stops offering it where a language is chosen. Language blocks already keyed to it keep resolving. */
  archive(context: unknown, key: string): Promise<ContentLanguageRecord | undefined>;
  /** Offers it again. */
  unarchive(context: unknown, key: string): Promise<ContentLanguageRecord | undefined>;
  /** Every entry, archived ones included, for the screen the registry is managed on. */
  list(context: unknown): Promise<readonly ContentLanguageRecord[]>;
  /** Only the entries still offered: what a language picker chooses from. */
  catalogue(context: unknown): Promise<readonly ContentLanguageRecord[]>;
}

export interface ContentLanguageOptions {
  /** Injected, so every instant this store writes comes from one clock and a test does not wait. */
  readonly now: () => string;
}

const STAMP_SEPARATOR = '#';

const readable = (problem: { readonly path: string; readonly message: string }): string =>
  `${problem.path} ${problem.message}`;

const problems = (list: readonly { readonly path: string; readonly message: string }[]): string =>
  list.map(readable).join('; ');

/**
 * The refusals the layer underneath raises, said in this store's own words. An `EntityError` is a
 * lifecycle rule — editing something archived, archiving it twice — which is the state it is in
 * rather than a bad payload. Anything else passes through: the records layer's own refusals about
 * context and permission are already the clearest statement of what went wrong.
 */
function refusalFor(error: unknown): unknown {
  if (error instanceof EntityError) return new ContentLanguageError('state', error.message);
  if (error instanceof RepositoryError && error.kind === 'duplicate') {
    return new ContentLanguageError('conflict', `${error.message}, so another writer stamped this key first`);
  }
  return error;
}

const own = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw refusalFor(error);
  }
};

/** What one stamp row holds, once it has been read back as something this build understands. */
interface StampRow extends ContentLanguageRecord {
  readonly sequence: number;
}

const draftOf = (row: ContentLanguageRecord): ContentLanguageDraft => ({
  displayName: row.displayName,
  script: row.script,
  fallbackFont: row.fallbackFont,
});

const recordOf = (stamp: EntityStamp, draft: ContentLanguageDraft): ContentLanguageRecord => ({ stamp, ...draft });

export function contentLanguagesOn(db: RepositoryDb, options: ContentLanguageOptions): ContentLanguageStore {
  const records = repositoriesOn(db)[CONTENT_LANGUAGE_RECORD];

  const author = (context: unknown): Pick<RequestContext, 'actor' | 'correlationId'> => {
    const { actor, correlationId } = context as RequestContext;
    return { actor, correlationId };
  };

  const rowFrom = (found: Document): StampRow => {
    const displayName = found['displayName'];
    const script = found['script'];
    const fallbackFont = found['fallbackFont'];
    const sequence = found['sequence'];
    if (
      typeof displayName !== 'string' ||
      typeof script !== 'string' ||
      typeof fallbackFont !== 'string' ||
      typeof sequence !== 'number'
    ) {
      throw new ContentLanguageError('corrupt', 'a content language is stamped with a field this code cannot read');
    }
    const parsed = parseEntityStamp(found['stamp']);
    if (!parsed.ok) {
      throw new ContentLanguageError('corrupt', `a content language holds a stamp this code cannot read: ${problems(parsed.problems)}`);
    }
    return { stamp: parsed.value, displayName, script, fallbackFont, sequence };
  };

  /** The standing stamp of one key, or nothing at all when no such key was ever created. */
  const standing = async (context: unknown, key: string): Promise<StampRow | undefined> => {
    const [found] = await records.read(context, { languageKey: key }, { sort: { sequence: -1 }, limit: 1 });
    return found === undefined ? undefined : rowFrom(found);
  };

  const everything = async (context: unknown): Promise<readonly StampRow[]> => {
    const found = await records.read(context, {});
    const byKey = new Map<string, StampRow>();
    for (const document of found) {
      const languageKey = document['languageKey'];
      if (typeof languageKey !== 'string') {
        throw new ContentLanguageError('corrupt', 'a content language is missing its key');
      }
      const row = rowFrom(document);
      const current = byKey.get(languageKey);
      if (current === undefined || current.sequence < row.sequence) byKey.set(languageKey, row);
    }
    return [...byKey.values()];
  };

  const readDraft = (draft: ContentLanguageDraft): ContentLanguageDraft => {
    const parsed = parseContentLanguageDraft(draft, 'contentLanguage');
    if (!parsed.ok) throw new ContentLanguageError('schema', `this is not a content language: ${problems(parsed.problems)}`);
    return parsed.value;
  };

  const readKey = (key: string): string => {
    if (key === '') throw new ContentLanguageError('schema', 'key must not be empty');
    return key;
  };

  const stampOnto = async (
    context: unknown,
    stamp: EntityStamp,
    draft: ContentLanguageDraft,
    sequence: number,
  ): Promise<ContentLanguageRecord> => {
    await records.append(context, {
      _id: `${stamp.id}${STAMP_SEPARATOR}${sequence}`,
      languageKey: stamp.id,
      sequence,
      at: stamp.updatedAt,
      displayName: draft.displayName,
      script: draft.script,
      fallbackFont: draft.fallbackFont,
      stamp,
      ...author(context),
    });
    return recordOf(stamp, draft);
  };

  const restamp = async (
    context: unknown,
    key: string,
    claimOf: (row: StampRow) => ContentLanguageDraft | undefined,
    change: (row: StampRow, at: string, by: string) => EntityStamp,
  ): Promise<ContentLanguageRecord | undefined> => {
    const row = await standing(context, key);
    if (row === undefined) return undefined;
    const claim = claimOf(row);
    const at = options.now();
    return stampOnto(context, change(row, at, author(context).actor), claim ?? draftOf(row), row.sequence + 1);
  };

  return {
    create: (context, key, draft) =>
      own(async () => {
        const id = readKey(key);
        const claim = readDraft(draft);
        if ((await standing(context, id)) !== undefined) {
          throw new ContentLanguageError('conflict', `${id} is a content language another writer named first`);
        }
        const stamp = createdStamp({ id, kind: CONTENT_LANGUAGE_KIND, at: options.now(), by: author(context).actor });
        return stampOnto(context, stamp, claim, 1);
      }),

    get: (context, key) =>
      own(async () => {
        const row = await standing(context, key);
        return row === undefined ? undefined : recordOf(row.stamp, draftOf(row));
      }),

    edit: (context, key, draft) =>
      own(async () => {
        const claim = readDraft(draft);
        return restamp(context, key, () => claim, (row, at, by) => touchedStamp(row.stamp, { at, by }));
      }),

    archive: (context, key) =>
      own(() => restamp(context, key, () => undefined, (row, at, by) => archivedStamp(row.stamp, { at, by }))),

    unarchive: (context, key) =>
      own(() => restamp(context, key, () => undefined, (row, at, by) => restoredStamp(row.stamp, { at, by }))),

    list: (context) => own(async () => (await everything(context)).map((row) => recordOf(row.stamp, draftOf(row)))),

    catalogue: (context) =>
      own(async () =>
        (await everything(context))
          .filter((row) => row.stamp.archivedAt === undefined)
          .map((row) => recordOf(row.stamp, draftOf(row))),
      ),
  };
}
