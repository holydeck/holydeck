import { bundledCanon } from '@holydeck/core/canon';
import { HolyDeckError, formatMessage } from '@holydeck/core/messages';
import { translationId } from '@holydeck/core/translations';
import { parseVerseList } from '@holydeck/core/references';
import { statusForCode } from '../errors.js';
import { readVerses } from '../verses-service.js';
import { flagParam } from './verses.js';
import type { FastifyInstance } from 'fastify';
import type { TranslationStoreFile } from '@holydeck/core/storage';
import type { AppDeps } from '../app.js';

export function resolveLegacyBook(
  input: string,
  files: TranslationStoreFile[],
): { usfm: string; chapterCount: number } | undefined {
  const lower = input.toLowerCase();
  for (const file of files) {
    const match = file.canon?.books.find(
      (book) =>
        book.usfm.toLowerCase() === lower ||
        book.name.toLowerCase() === lower ||
        book.longName?.toLowerCase() === lower ||
        book.abbreviation?.toLowerCase() === lower,
    );
    if (match !== undefined) return { usfm: match.usfm, chapterCount: match.chapters.length };
  }
  const bundled = bundledCanon().books.find(
    (book) => book.usfm.toLowerCase() === lower || book.name.toLowerCase() === lower,
  );
  if (bundled !== undefined) return { usfm: bundled.usfm, chapterCount: bundled.chapters.length };
  return undefined;
}

export function resolveLegacyVersion(version: string): string {
  try {
    translationId(version);
    return version.toUpperCase();
  } catch {
    return 'KJV';
  }
}

interface LegacyQuery {
  book?: string;
  chapter?: string;
  verses?: string;
  version?: string;
  force?: string;
}

export function registerLegacyVerseRoute(api: FastifyInstance, deps: AppDeps): void {
  api.get<{ Querystring: LegacyQuery }>('/verse', async (request, reply) => {
    void reply.header('deprecation', 'true');
    request.log.warn(
      formatMessage('deprecated_route', {
        oldRoute: 'GET /api/v1/verse',
        newRoute: 'GET /api/v1/translations/:abbr/verses',
      }),
    );
    const query = request.query;
    if (query.book === undefined || query.book === '') {
      return reply.code(400).send({ statusCode: 400, message: "Missing field 'book'" });
    }
    try {
      const files = await deps.store.loadAll();
      const resolved = resolveLegacyBook(query.book, files);
      if (resolved === undefined) {
        return reply
          .code(400)
          .send({ statusCode: 400, message: `Could not find book '${query.book}' by name or alias.` });
      }
      const chapter = Number(query.chapter ?? '1');
      if (!Number.isInteger(chapter) || chapter < 1 || chapter > resolved.chapterCount) {
        return reply.code(400).send({ statusCode: 400, message: 'Chapter not found.' });
      }
      const result = await readVerses(deps.store, deps.fetcher, {
        abbr: resolveLegacyVersion(query.version ?? 'KJV'),
        book: resolved.usfm,
        chapter,
        verses: parseVerseList(query.verses ?? '1'),
        refresh: flagParam(query.force),
        fetchMissing: true,
      });
      return await reply.code(200).send({
        citation: result.citation,
        passage: result.verses.map((entry) => entry.text).join(' '),
        book: result.bookName,
        chapter,
        verses: query.verses ?? '1',
      });
    } catch (caught) {
      const error = caught instanceof HolyDeckError ? caught : new HolyDeckError('internal_error');
      const statusCode = statusForCode(error.code);
      return reply.code(statusCode).send({ statusCode, message: error.message });
    }
  });
}
