import { bundledCanon } from '@holydeck/core/canon';
import { knownTranslations, translationId } from '@holydeck/core/translations';
import { canonChapterTotal, storedChapterCount } from '../store-metrics.js';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';

function idOf(abbr: string): number {
  try {
    return translationId(abbr);
  } catch {
    return 0;
  }
}

export function registerTranslationsRoutes(api: FastifyInstance, deps: AppDeps): void {
  api.get('/translations', async () => {
    const files = await deps.store.loadAll();
    const byAbbr = new Map(files.map((file) => [file.translation, file]));
    const abbrs = [...new Set([...Object.keys(knownTranslations), ...byAbbr.keys()])].sort();
    return {
      translations: abbrs.map((abbr) => {
        const file = byAbbr.get(abbr);
        return {
          abbreviation: abbr,
          id: idOf(abbr),
          title: file?.meta?.localTitle ?? abbr,
          language: file?.meta?.language.name ?? '',
          syncedChapters: file === undefined ? 0 : storedChapterCount(file),
          canonChapters: canonChapterTotal(file),
          cached: file !== undefined,
        };
      }),
    };
  });

  api.get<{ Params: { abbr: string } }>('/translations/:abbr/canon', async (request) => {
    const abbr = request.params.abbr.toUpperCase();
    const file = await deps.store.load(abbr);
    const canon = file?.canon;
    if (canon === undefined) translationId(abbr);
    return {
      translation: abbr,
      source: canon === undefined ? 'bundled' : 'synced',
      books: (canon ?? bundledCanon()).books,
    };
  });
}
