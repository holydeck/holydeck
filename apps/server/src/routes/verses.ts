import { formatMessage } from '@holydeck/core/messages';
import { parseVerseList } from '@holydeck/core/references';
import { readVerses } from '../verses-service.js';
import type { FastifyInstance } from 'fastify';
import type { VerseMap } from '@holydeck/core/storage';
import type { AppDeps } from '../app.js';

/** A query flag: present-but-empty means on, and an absent flag falls back to the route's default. */
export function flagParam(value: unknown, fallback = false): boolean {
  if (value === undefined) return fallback;
  return value === true || value === 'true' || value === '';
}

interface VersesQuery {
  book: string;
  chapter: number;
  verses: string;
  refresh?: unknown;
  fetchMissing?: unknown;
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
            fetchMissing: {},
            revision: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request) => {
      const query = request.query;
      const result = await readVerses(
        deps.store,
        deps.fetcher,
        {
          abbr: request.params.abbr,
          book: query.book,
          chapter: query.chapter,
          verses: parseVerseList(query.verses),
          refresh: flagParam(query.refresh),
          fetchMissing: flagParam(query.fetchMissing, true),
          revision: query.revision,
        },
        (reason) => request.log.warn(formatMessage('canon_unavailable', { abbr: request.params.abbr, reason })),
      );
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
