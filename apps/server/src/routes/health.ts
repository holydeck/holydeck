import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';

export function registerHealthRoute(app: FastifyInstance, deps: AppDeps): void {
  app.get('/health', async () => {
    const storeOk = await deps.store.ping();
    return {
      status: storeOk ? 'ok' : 'degraded',
      version: deps.version,
      uptime: Math.round(process.uptime()),
      store: storeOk ? 'ok' : 'unreachable',
    };
  });
}
