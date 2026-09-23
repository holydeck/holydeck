// Bridges a sermon's assembled entries to the corpus this deployment holds (spec SERM-01, CRT-05).
//
// `packages/core/src/assemble.ts`'s `assembleEntries` reads a `TranslationStoreFile` per translation —
// the shape the CLI and the corpus sync job build from a Mongo-backed `ChapterStore`. This application
// has no such store; it only ever reaches the corpus over HTTP, through `corpus.ts`'s client. This file
// is the one place that gap is bridged: a request-scoped, single-revision `TranslationStoreFile` is
// built by hand from `corpus.verses()` answers, just for the entries one `POST /:id/slides` call needs,
// then thrown away — nothing here is persisted, so `appendRevision`'s auto-incrementing history is the
// wrong tool for it.

import { chapterRefs } from '@holydeck/core/fetch-missing';
import { contentHash, createEmptyStoreFile } from '@holydeck/core/storage';

import type { ChapterRecord, ChapterRevision, TranslationStoreFile, VerseMap } from '@holydeck/core/storage';
import type { ChapterRef } from '@holydeck/core/fetch-missing';
import type { SermonFile } from '@holydeck/core/sermon';
import type { CorpusResult, corpusClient } from './corpus.js';

/** Every actual (offset-adjusted) verse number a sermon's entries ask of one translation in one chapter. */
function versesNeeded(sermon: SermonFile, abbr: string, ref: ChapterRef): readonly number[] {
  const verses = new Set<number>();
  for (const entry of sermon.entries) {
    if (entry.book !== ref.book || String(entry.chapter) !== ref.chapter) continue;
    const offset = entry.offsets[abbr] ?? 0;
    for (const verse of entry.verses) verses.add(verse + offset);
  }
  return [...verses].sort((a, b) => a - b);
}

/**
 * The `storeFiles` a sermon's `POST /:id/slides` needs, sourced live from the corpus rather than a
 * datastore this application does not have. Short-circuits on the corpus's own first refusal, already
 * translated into this application's published vocabulary by `corpus.ts` — nothing here re-maps it.
 */
export async function sermonStoreFilesFromCorpus(
  corpus: ReturnType<typeof corpusClient>,
  sermon: SermonFile,
): Promise<CorpusResult<Record<string, TranslationStoreFile>>> {
  const refs = chapterRefs(sermon);
  const files: Record<string, TranslationStoreFile> = {};
  for (const abbr of sermon.translations) {
    const file = createEmptyStoreFile(abbr, '');
    for (const ref of refs) {
      const verses = versesNeeded(sermon, abbr, ref);
      if (verses.length === 0) continue;
      const answer = await corpus.verses(abbr, ref.book, Number(ref.chapter), verses);
      if (!answer.ok) return answer;
      const revision: ChapterRevision = {
        rev: answer.value.revision,
        fetchedAt: answer.value.fetchedAt,
        contentHash: contentHash(answer.value.verses as VerseMap),
        verses: answer.value.verses as VerseMap,
      };
      const record: ChapterRecord = { canonVerseCount: verses.length, revisions: [revision] };
      const book = file.books[ref.book] ?? { chapters: {} };
      book.chapters[ref.chapter] = record;
      file.books[ref.book] = book;
      file.updatedAt = answer.value.fetchedAt;
    }
    files[abbr] = file;
  }
  return { ok: true, value: files };
}
