import { assembleEntries } from '@holydeck/core/assemble';
import { parseSermonFile } from '@holydeck/core/sermon';
import { renderOutput } from '@holydeck/core/template';
import type { FastifyInstance } from 'fastify';
import type { TranslationStoreFile } from '@holydeck/core/storage';
import type { AppDeps } from '../app.js';

export function registerRenderRoute(api: FastifyInstance, deps: AppDeps): void {
  api.post('/render', async (request) => {
    const body = request.body;
    const text = typeof body === 'string' ? body : JSON.stringify(body ?? null);
    const sermon = parseSermonFile(text);
    const storeFiles: Record<string, TranslationStoreFile | undefined> = {};
    for (const abbr of sermon.translations) {
      storeFiles[abbr.toUpperCase()] = await deps.store.load(abbr);
    }
    const entries = assembleEntries(sermon, storeFiles);
    const notices = [...sermon.notices];
    const output = await renderOutput(sermon.template, entries, notices);
    return { output, notices };
  });
}
