import { assembleEntries } from '@holydeck/core/assemble';
import { chapterRefs, ensureChapters } from '@holydeck/core/fetch-missing';
import { parseSermonFile } from '@holydeck/core/sermon';
import { renderOutput } from '@holydeck/core/template';
import { flagParam } from './verses.js';
import type { FastifyInstance } from 'fastify';
import type { TranslationStoreFile } from '@holydeck/core/storage';
import type { AppDeps } from '../app.js';

export function registerRenderRoute(api: FastifyInstance, deps: AppDeps): void {
  api.post<{ Querystring: { refresh?: unknown; fetchMissing?: unknown } }>('/render', async (request) => {
    const body = request.body;
    const text = typeof body === 'string' ? body : JSON.stringify(body ?? null);
    const sermon = parseSermonFile(text);
    const options = {
      refresh: flagParam(request.query.refresh),
      fetchMissing: flagParam(request.query.fetchMissing, true),
    };
    const refs = chapterRefs(sermon);
    const storeFiles: Record<string, TranslationStoreFile | undefined> = {};
    for (const abbr of sermon.translations) {
      const { file } = await ensureChapters(deps.store, deps.fetcher, abbr, refs, options);
      storeFiles[abbr.toUpperCase()] = file;
    }
    const entries = assembleEntries(sermon, storeFiles);
    const notices = [...sermon.notices];
    const output = await renderOutput(sermon.template, entries, notices);
    return { output, notices };
  });
}
