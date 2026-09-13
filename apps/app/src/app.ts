import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import type { LoadedSettings } from './settings.js';

export interface AppOptions {
  settings: LoadedSettings;
  /** Explicit rather than defaulted: a service that silently stops logging is hard to notice. */
  logger: FastifyServerOptions['logger'];
}

export function buildApp({ settings, logger }: AppOptions): FastifyInstance {
  const app = Fastify({ logger });
  app.get('/health', () => ({ status: 'ok', locale: settings.values.locale }));
  return app;
}
