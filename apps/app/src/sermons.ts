import { assembleEntries } from '@holydeck/core/assemble';

import { requestContext } from './context.js';
import { LIBRARY_PERMISSIONS, LibraryError, libraryOn } from './library.js';
import { RepositoryError } from './repositories.js';
import { REVISION_PERMISSIONS, RevisionError, revisionsOn } from './revisions.js';
import { nonempty, parseSermonBody } from './sermon-body.js';
import { sermonFromYaml, sermonToYaml } from './sermon-yaml.js';
import { SlideGroupError, slideGroupsOn } from './slide-groups.js';
import { LAYOUT_PERMISSIONS, SlideLayoutError, slideLayoutsOn } from './slide-layouts.js';

import type { EntityStamp } from '@holydeck/contracts/entities';
import type { KeyedBinding } from '@holydeck/contracts/layouts';
import type { RevisionRecord } from '@holydeck/contracts/revisions';
import type { LanguageBlock, SlideGroupBody } from '@holydeck/contracts/slide-groups';
import type { AssembleOptions } from '@holydeck/core/assemble';
import type { TranslationStoreFile } from '@holydeck/core/storage';
import type { EntryData } from '@holydeck/core/template';

import type { RequestContext } from './context.js';
import type { LibraryRecord } from './library.js';
import type { RepositoryDb } from './repositories.js';
import type { SermonBody, SermonLanguage } from './sermon-body.js';
import type { LocatedProblem } from './sermon-yaml.js';
import type { SlideGroupRecord } from './slide-groups.js';

export type { SermonBody, SermonLanguage };

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
  /** Saves a configuration forward from the visual surface. */
  edit(context: unknown, id: string, body: SermonBody): Promise<SermonRecord | undefined>;
  /** The same configuration as the text the raw surface edits. */
  raw(context: unknown, id: string, revision?: number): Promise<string | undefined>;
  /** Saves what the raw surface typed. Refuses with a located problem, having written nothing. */
  editRaw(context: unknown, id: string, text: string): Promise<SermonRecord | undefined>;
  history(context: unknown, id: string): Promise<readonly SermonRecord[]>;
  generate(context: unknown, id: string, input: SermonGeneration): Promise<SlideGroupRecord>;
}

export interface SermonOptions {
  readonly now: () => string;
  readonly newId?: () => string;
}

export type SermonRefusal = 'schema' | 'state' | 'permission' | 'conflict' | 'corrupt';

/**
 * Carries why the call was refused, and — for a refusal about the configuration itself — the problem that
 * made it one, where the raw editor should put its marker. Empty for a refusal that is not about a
 * payload at all, such as a race this caller lost.
 */
export class SermonError extends Error {
  readonly problems: readonly LocatedProblem[];

  constructor(readonly kind: SermonRefusal, message: string, problems: readonly LocatedProblem[] = []) {
    super(message);
    this.name = 'SermonError';
    this.problems = problems;
  }
}

export function sermonContext(actor: string, correlationId: string): RequestContext {
  return requestContext({
    actor, correlationId,
    permissions: [...Object.values(LIBRARY_PERMISSIONS), ...Object.values(REVISION_PERMISSIONS), LAYOUT_PERMISSIONS.read],
  });
}

export const subjectFor = (id: string): string => `sermon:${id}`;

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

/** The configuration a caller handed in or a stored revision holds, graded by the one schema either owns. */
function readBody(value: unknown, kind: 'schema' | 'corrupt' = 'schema'): SermonBody {
  const parsed = parseSermonBody(value);
  if (!parsed.ok) {
    throw new SermonError(kind, parsed.problems[0]?.message ?? 'this is not a sermon configuration', parsed.problems);
  }
  return parsed.value;
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
    raw: (context, id, revision) => own(async () => {
      const row = await standing(context, id, revision);
      return row === undefined ? undefined : sermonToYaml(row.body);
    }),
    editRaw: (context, id, text) => own(async () => {
      const read = sermonFromYaml(text);
      if (!read.ok) {
        throw new SermonError('schema', read.problems[0]?.message ?? 'this text is not a sermon configuration', read.problems);
      }
      const row = await standing(context, id);
      return row === undefined ? undefined : save(context, row, read.value);
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
