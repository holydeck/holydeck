import { createHash } from 'node:crypto';
import { asNumber, asObject } from './internal/json.js';
import { HolyDeckError } from './messages.js';
import type { Canon, TranslationMeta } from './canon.js';

export const STORE_SCHEMA_VERSION = 1;

export type VerseMap = Record<string, string>;

export interface ChapterRevision {
  rev: number;
  fetchedAt: string;
  contentHash: string;
  verses: VerseMap;
}

export interface ChapterRecord {
  canonVerseCount: number;
  revisions: ChapterRevision[];
}

export interface TranslationStoreFile {
  schemaVersion: number;
  translation: string;
  updatedAt: string;
  meta?: TranslationMeta;
  canon?: Canon;
  books: Record<string, { chapters: Record<string, ChapterRecord> }>;
}

export function contentHash(verses: VerseMap): string {
  const entries = Object.keys(verses)
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => [key, verses[key]]);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export function latestRevision(record: ChapterRecord): ChapterRevision | undefined {
  return record.revisions[record.revisions.length - 1];
}

export function findRevision(
  record: ChapterRecord,
  rev: number,
  ref: { abbr: string; book: string; chapter: string },
): ChapterRevision {
  const found = record.revisions.find((revision) => revision.rev === rev);
  if (found === undefined) {
    throw new HolyDeckError('revision_not_found', {
      rev,
      ...ref,
      available: record.revisions.map((revision) => revision.rev).join(', '),
    });
  }
  return found;
}

export function appendRevision(
  record: ChapterRecord | undefined,
  verses: VerseMap,
  canonVerseCount: number,
  fetchedAt: string,
): { record: ChapterRecord; changed: boolean; rev: number } {
  const hash = contentHash(verses);
  const revisions = record?.revisions ?? [];
  const latest = revisions[revisions.length - 1];
  if (latest !== undefined && latest.contentHash === hash) {
    return { record: { canonVerseCount, revisions }, changed: false, rev: latest.rev };
  }
  const rev = (latest?.rev ?? 0) + 1;
  return {
    record: { canonVerseCount, revisions: [...revisions, { rev, fetchedAt, contentHash: hash, verses }] },
    changed: true,
    rev,
  };
}

export function getChapter(
  file: TranslationStoreFile | undefined,
  book: string,
  chapter: string,
): ChapterRecord | undefined {
  return file?.books[book]?.chapters[chapter];
}

export function createEmptyStoreFile(translation: string, now: string): TranslationStoreFile {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    translation: translation.toUpperCase(),
    updatedAt: now,
    books: {},
  };
}

export function validateStoreFile(raw: unknown, path: string): TranslationStoreFile {
  const obj = asObject(raw);
  const schemaVersion = obj === undefined ? undefined : asNumber(obj.schemaVersion);
  if (
    obj === undefined ||
    schemaVersion === undefined ||
    typeof obj.translation !== 'string' ||
    asObject(obj.books) === undefined
  ) {
    throw new HolyDeckError('store_corrupt', { path, reason: 'missing schemaVersion, translation or books' });
  }
  if (schemaVersion > STORE_SCHEMA_VERSION) {
    throw new HolyDeckError('store_newer_schema', { path, found: schemaVersion, supported: STORE_SCHEMA_VERSION });
  }
  return raw as TranslationStoreFile;
}
