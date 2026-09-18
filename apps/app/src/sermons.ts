import { isContentLanguageKey } from '@holydeck/contracts/content-languages';
import { isRecord } from '@holydeck/contracts/problems';
import { assembleEntries } from '@holydeck/core/assemble';
import { parseSermonFile } from '@holydeck/core/sermon';

import { requestContext } from './context.js';
import { LIBRARY_PERMISSIONS, LibraryError, libraryOn } from './library.js';
import { RepositoryError } from './repositories.js';
import { REVISION_PERMISSIONS, RevisionError, revisionsOn } from './revisions.js';
import { SlideGroupError, slideGroupsOn } from './slide-groups.js';
import { LAYOUT_PERMISSIONS, SlideLayoutError, slideLayoutsOn } from './slide-layouts.js';

import type { EntityStamp } from '@holydeck/contracts/entities';
import type { KeyedBinding } from '@holydeck/contracts/layouts';
import type { RevisionRecord } from '@holydeck/contracts/revisions';
import type { LanguageBlock, SlideGroupBody } from '@holydeck/contracts/slide-groups';
import type { AssembleOptions } from '@holydeck/core/assemble';
import type { SermonFile } from '@holydeck/core/sermon';
import type { TranslationStoreFile } from '@holydeck/core/storage';
import type { EntryData } from '@holydeck/core/template';

import type { RequestContext } from './context.js';
import type { LibraryRecord } from './library.js';
import type { RepositoryDb } from './repositories.js';
import type { SlideGroupRecord } from './slide-groups.js';

export type SermonLanguage = {
  readonly translation: string;
  readonly title: string;
  readonly speaker?: string;
  /** When supplied, one point per SermonFile entry, in the same order. */
  readonly points?: readonly string[];
};

export type SermonBody = {
  readonly sermon: SermonFile;
  /** Content-language keys map explicitly to translations; they are not translation abbreviations. */
  readonly languages: Readonly<Record<string, SermonLanguage>>;
};

export type SermonGeneratedFrom = {
  readonly sermonId: string;
  readonly sermonRevision: number;
  readonly slideLayoutId: string;
  readonly slideLayoutRevision: number;
};

export interface SermonGeneration {
  readonly sermonRevision: number;
  readonly slideLayoutId: string;
  readonly slideLayoutRevision: number;
  readonly storeFiles: Record<string, TranslationStoreFile | undefined>;
  readonly assembleOptions?: AssembleOptions;
  /** Omit to create a group; supply to regenerate this sermon's existing generated group. */
  readonly slideGroupId?: string;
}

export interface SermonRecord {
  readonly stamp: EntityStamp;
  readonly title: string;
  readonly revision: number;
  readonly at: string;
  readonly body: SermonBody;
}

export interface SermonStore {
  create(context: unknown, title: string, body: SermonBody): Promise<SermonRecord>;
  current(context: unknown, id: string, revision?: number): Promise<SermonRecord | undefined>;
  edit(context: unknown, id: string, body: SermonBody): Promise<SermonRecord | undefined>;
  history(context: unknown, id: string): Promise<readonly SermonRecord[]>;
  generate(context: unknown, id: string, input: SermonGeneration): Promise<SlideGroupRecord>;
}

export interface SermonOptions {
  readonly now: () => string;
  readonly newId?: () => string;
}

export type SermonRefusal = 'schema' | 'state' | 'permission' | 'conflict' | 'corrupt';

export class SermonError extends Error {
  constructor(readonly kind: SermonRefusal, message: string) {
    super(message);
    this.name = 'SermonError';
  }
}

export function sermonContext(actor: string, correlationId: string): RequestContext {
  return requestContext({
    actor, correlationId,
    permissions: [...Object.values(LIBRARY_PERMISSIONS), ...Object.values(REVISION_PERMISSIONS), LAYOUT_PERMISSIONS.read],
  });
}

const own = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RepositoryError && error.kind === 'permission') {
      throw new SermonError('permission', error.message);
    }
    if (error instanceof RevisionError) {
      throw new SermonError(error.kind === 'missing' ? 'state' : error.kind, error.message);
    }
    if (error instanceof LibraryError || error instanceof SlideGroupError || error instanceof SlideLayoutError) {
      throw new SermonError(error.kind, error.message);
    }
    throw error;
  }
};

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

function readBody(value: unknown, kind: 'schema' | 'corrupt' = 'schema'): SermonBody {
  const reject = (message: string): never => { throw new SermonError(kind, message); };
  if (!isRecord(value) || !isRecord(value['sermon']) || !isRecord(value['languages'])) {
    return reject('a sermon configuration needs a SermonFile and language content');
  }
  const file = value['sermon'];
  const entries = file['entries'];
  const notices = file['notices'];
  if (!Array.isArray(entries) || !Array.isArray(notices) || !notices.every((notice) => typeof notice === 'string')) {
    return reject('a SermonFile needs entries and string notices');
  }
  // Reuse the parser's book, verse, translation and offset rules for its structured output too.
  const verses = entries.map((entry: unknown) => {
    if (!isRecord(entry) || !Array.isArray(entry['verses']) ||
        !entry['verses'].every((verse: unknown) => typeof verse === 'number' && Number.isInteger(verse)) ||
        !isRecord(entry['offsets'])) {
      return reject('each SermonFile entry needs numeric verses and translation offsets');
    }
    return { ...entry, verses: entry['verses'].join(',') };
  });
  let sermon: SermonFile;
  try {
    sermon = parseSermonFile(JSON.stringify({ translations: file['translations'], template: file['template'], verses }));
  } catch (error) {
    return reject(`invalid SermonFile: ${String(error)}`);
  }
  sermon.notices = [...notices];
  const languages: Record<string, SermonLanguage> = {};
  for (const [key, content] of Object.entries(value['languages'])) {
    if (!isContentLanguageKey(key) || !isRecord(content) || !nonempty(content['title']) ||
        typeof content['translation'] !== 'string' || !sermon.translations.includes(content['translation'])) {
      return reject(`${key} needs a registered language, title and a translation selected by the sermon`);
    }
    const speaker = content['speaker'];
    const points = content['points'];
    if (speaker !== undefined && !nonempty(speaker)) return reject(`${key}.speaker must be nonempty text`);
    if (points !== undefined && (!Array.isArray(points) || points.length !== sermon.entries.length || !points.every(nonempty))) {
      return reject(`${key}.points must contain one nonempty point per sermon entry`);
    }
    languages[key] = {
      title: content['title'], translation: content['translation'],
      ...(speaker === undefined ? {} : { speaker }), ...(points === undefined ? {} : { points }),
    };
  }
  if (Object.keys(languages).length === 0) return reject('a sermon configuration needs at least one content language');
  return { sermon, languages };
}

function boundText(body: SermonBody, entry: EntryData, index: number, binding: KeyedBinding): string {
  const language = body.languages[binding.languageKey];
  const passage = entry.passages.find((candidate) => candidate.translation === language?.translation);
  if (language === undefined || passage === undefined) {
    throw new SermonError('state', `${binding.languageKey} has no sermon content and assembled translation`);
  }
  const fields: Readonly<Record<string, Readonly<Record<string, string | undefined>>>> = {
    sermon: { title: language.title, speaker: language.speaker, point: language.points?.[index], scriptureRef: passage.citation },
    reading: { reference: passage.citation, verseText: passage.text, translation: passage.translation },
  };
  const text = fields[binding.contentKind]?.[binding.contentKey];
  if (!nonempty(text)) {
    throw new SermonError('state', `${binding.contentKind}.${binding.contentKey} has no content in ${binding.languageKey}`);
  }
  return text;
}

export function sermonsOn(db: RepositoryDb, options: SermonOptions): SermonStore {
  const library = libraryOn(db, options);
  const revisions = revisionsOn(db, options);
  const layouts = slideLayoutsOn(db, options);
  const groups = slideGroupsOn(db, options);

  const listed = async (context: unknown, id: string): Promise<LibraryRecord | undefined> => {
    const row = await library.get(context, id);
    if (row !== undefined && row.stamp.kind !== 'sermon') throw new SermonError('state', `${id} is not a sermon`);
    return row;
  };
  const record = (row: LibraryRecord, held: RevisionRecord): SermonRecord => ({
    ...row, revision: held.revision, at: held.at, body: readBody(held.body, 'corrupt'),
  });
  const standing = async (context: unknown, id: string, revision?: number): Promise<SermonRecord | undefined> => {
    const row = await listed(context, id);
    if (row === undefined) return undefined;
    const held = revision === undefined ? await revisions.current(context, id) : await revisions.read(context, id, revision);
    if (held === undefined) {
      if (revision !== undefined) return undefined;
      throw new SermonError('corrupt', `${id} is stamped as a sermon and holds no configuration`);
    }
    return record(row, held);
  };
  const save = async (context: unknown, row: LibraryRecord, body: SermonBody): Promise<SermonRecord> => {
    const saved = await revisions.save(context, { contentId: row.stamp.id, body, origin: 'manual-checkpoint' });
    return record(row, saved.revision);
  };

  return {
    create: (context, title, body) => own(async () => {
      const configuration = readBody(body);
      const row = await library.create(context, { kind: 'sermon', title });
      return save(context, row, configuration);
    }),
    current: (context, id, revision) => own(() => standing(context, id, revision)),
    edit: (context, id, body) => own(async () => {
      const configuration = readBody(body);
      const row = await standing(context, id);
      return row === undefined ? undefined : save(context, row, configuration);
    }),
    history: (context, id) => own(async () => {
      const row = await listed(context, id);
      if (row === undefined) return [];
      return (await revisions.history(context, id)).map((held) => record(row, held));
    }),
    generate: (context, id, input) => own(async () => {
      if (!Number.isSafeInteger(input.sermonRevision) || input.sermonRevision < 1 ||
          !Number.isSafeInteger(input.slideLayoutRevision) || input.slideLayoutRevision < 1 || !nonempty(input.slideLayoutId)) {
        throw new SermonError('schema', 'generation requires explicit positive sermon and Slide Layout revisions and a Layout id');
      }
      const source = await standing(context, id, input.sermonRevision);
      if (source === undefined) throw new SermonError('state', `${id} has no sermon revision ${input.sermonRevision}`);
      const layout = await layouts.preview(context, input.slideLayoutId, input.slideLayoutRevision);
      if (layout === undefined) throw new SermonError('state', `${input.slideLayoutId} has no Layout revision ${input.slideLayoutRevision}`);
      const entries = assembleEntries(source.body.sermon, input.storeFiles, input.assembleOptions);
      const generatedFrom: SermonGeneratedFrom = {
        sermonId: id, sermonRevision: source.revision,
        slideLayoutId: input.slideLayoutId, slideLayoutRevision: layout.revision,
      };
      const body: SlideGroupBody = {
        mode: 'generated', enabled: true, slideLayoutId: input.slideLayoutId, generatedFrom,
        slides: entries.map((entry, index) => ({
          id: `entry-${index + 1}`, enabled: true, label: entry.reference,
          // Static text and media remain on the pinned Layout; keyed blocks retain their box ids.
          languageBlocks: layout.body.boxes.flatMap((box): LanguageBlock[] =>
            box.kind !== 'text' || box.binding.mode !== 'keyed' ? [] : [{
              id: box.id, languageKey: box.binding.languageKey, text: boundText(source.body, entry, index, box.binding),
            }]),
        })),
      };
      if (input.slideGroupId === undefined) return groups.create(context, 'slideGroup', source.title, body);
      const target = await groups.current(context, input.slideGroupId);
      if (target?.stamp.kind !== 'slideGroup' || target.body.mode !== 'generated' || target.body.generatedFrom?.['sermonId'] !== id) {
        throw new SermonError('state', `${input.slideGroupId} is not a generated slide group for this sermon`);
      }
      const regenerated = await groups.regenerate(context, input.slideGroupId, body);
      if (regenerated === undefined) throw new SermonError('state', `${input.slideGroupId} no longer exists`);
      return regenerated;
    }),
  };
}
