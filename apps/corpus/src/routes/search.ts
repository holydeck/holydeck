import { searchTranslation } from '@holydeck/core/search';
import { translationId } from '@holydeck/core/translations';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';

/**
 * Searches a translation's stored text, and only its stored text. The handler reads the store and
 * nothing else — it never touches the fetcher — so a search can neither reach the upstream site nor
 * quietly sync what it did not find. A translation nothing has been synced into is locally unavailable
 * and answers with no hits; a translation this build has never heard of is refused outright, the way
 * the canon route refuses one, so a misspelled name is not read as an empty library.
 */
export function registerSearchRoute(api: FastifyInstance, deps: AppDeps): void {
  api.get<{ Params: { abbr: string }; Querystring: { q: string } }>(
    '/translations/:abbr/search',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['q'],
          properties: { q: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request) => {
      const abbr = request.params.abbr.toUpperCase();
      const query = request.query.q;
      const file = await deps.store.load(abbr);
      if (file === undefined) translationId(abbr);
      return { translation: abbr, query, hits: file === undefined ? [] : searchTranslation(file, query) };
    },
  );
}
