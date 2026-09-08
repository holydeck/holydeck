import { bundledCanon } from '@holydeck/core/canon';
import type { TranslationStoreFile } from '@holydeck/core/storage';

export function storedChapterCount(file: TranslationStoreFile): number {
  return Object.values(file.books).reduce((sum, book) => sum + Object.keys(book.chapters).length, 0);
}

export function revisionCount(file: TranslationStoreFile): number {
  return Object.values(file.books).reduce(
    (sum, book) =>
      sum + Object.values(book.chapters).reduce((inner, chapter) => inner + chapter.revisions.length, 0),
    0,
  );
}

export function canonChapterTotal(file: TranslationStoreFile | undefined): number {
  const canon = file?.canon ?? bundledCanon();
  return canon.books.reduce((sum, book) => sum + book.chapters.length, 0);
}
