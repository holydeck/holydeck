import { HolyDeckError } from '@holydeck/core/messages';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';

export function registerSyncRoutes(api: FastifyInstance, deps: AppDeps): void {
  api.post<{ Params: { abbr: string } }>('/translations/:abbr/sync', async (request, reply) => {
    const body: unknown = request.body;
    const refresh =
      typeof body === 'object' && body !== null && (body as { refresh?: unknown }).refresh === true;
    const status = deps.jobs.start(request.params.abbr, refresh);
    return reply.code(202).send(status);
  });

  api.get<{ Params: { abbr: string } }>('/translations/:abbr/sync', async (request) => {
    const status = await deps.jobs.status(request.params.abbr);
    if (status === undefined) {
      throw new HolyDeckError('sync_job_not_found', { abbr: request.params.abbr.toUpperCase() });
    }
    return status;
  });
}
