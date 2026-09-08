import { canonChapterTotal, revisionCount, storedChapterCount } from '../store-metrics.js';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';

export function registerStatsRoute(api: FastifyInstance, deps: AppDeps): void {
  api.get('/stats', async () => {
    const files = await deps.store.loadAll();
    const translations = files.map((file) => ({
      abbr: file.translation,
      chapters: { stored: storedChapterCount(file), total: canonChapterTotal(file) },
      revisions: revisionCount(file),
      updatedAt: file.updatedAt,
    }));
    return {
      translations,
      totals: {
        translations: translations.length,
        chapters: translations.reduce((sum, row) => sum + row.chapters.stored, 0),
        revisions: translations.reduce((sum, row) => sum + row.revisions, 0),
      },
    };
  });
}
