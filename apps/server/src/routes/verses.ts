import { parseVerseList } from '@holydeck/core/references';
import { readVerses } from '../verses-service.js';
import type { FastifyInstance } from 'fastify';
import type { VerseMap } from '@holydeck/core/storage';
import type { AppDeps } from '../app.js';

export function flagParam(value: unknown): boolean {
  return value === true || value === 'true' || value === '';
}

interface VersesQuery {
  book: string;
  chapter: number;
  verses: string;
  refresh?: unknown;
  revision?: number;
}

export function registerVersesRoute(api: FastifyInstance, deps: AppDeps): void {
  api.get<{ Params: { abbr: string }; Querystring: VersesQuery }>(
    '/translations/:abbr/verses',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['book', 'chapter', 'verses'],
          properties: {
            book: { type: 'string', pattern: '^[0-9A-Za-z]{3}$' },
            chapter: { type: 'integer', minimum: 1 },
            verses: { type: 'string', minLength: 1 },
            refresh: {},
            revision: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request) => {
      const query = request.query;
      const result = await readVerses(deps.store, deps.fetcher, {
        abbr: request.params.abbr,
        book: query.book,
        chapter: query.chapter,
        verses: parseVerseList(query.verses),
        refresh: flagParam(query.refresh),
        revision: query.revision,
      });
      const verses: VerseMap = {};
      for (const entry of result.verses) {
        verses[String(entry.verse)] = entry.text;
      }
      return {
        verses,
        citation: result.citation,
        revision: result.revision,
        fetchedAt: result.fetchedAt,
        source: result.source,
      };
    },
  );
}
