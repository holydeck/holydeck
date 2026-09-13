import { describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { DEFAULT_SETTINGS, type LoadedSettings } from './settings.js';

const settings: LoadedSettings = {
  values: { ...DEFAULT_SETTINGS, locale: 'de' },
  sources: { port: 'default', dataDir: 'default', mediaRoot: 'default', locale: 'file' },
  path: '/data/holydeck/config/settings.yaml',
};

describe('the application server', () => {
  it('reports itself healthy with the locale it will serve', async () => {
    const app = buildApp({ settings, logger: false });
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'ok', locale: 'de' });
    } finally {
      await app.close();
    }
  });

  it('answers an unknown path with a not-found status, not with the web shell', async () => {
    const app = buildApp({ settings, logger: false });
    try {
      const response = await app.inject({ method: 'GET', url: '/nope' });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
