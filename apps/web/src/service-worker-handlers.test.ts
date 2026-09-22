import { describe, expect, it, vi } from 'vitest';

import {
  CACHE_NAME,
  CACHE_PREFIX,
  type ResponseLike,
  PRECACHE,
  dropOtherCaches,
  precache,
  respond,
} from './service-worker-handlers.js';

const cached = { body: 'from cache' };
const fresh = { body: 'from network' };

const fakeCaches = (entries: Record<string, ResponseLike> = {}, names: string[] = [CACHE_NAME]) => {
  const cache = {
    match: vi.fn(async (url: string): Promise<ResponseLike | undefined> => entries[url]),
    addAll: vi.fn(async () => undefined),
    put: vi.fn(async () => undefined),
  };
  return {
    cache,
    storage: {
      open: vi.fn(async () => cache),
      keys: vi.fn(async () => names),
      delete: vi.fn(async () => true),
    },
  };
};

describe('installing', () => {
  it('precaches the shell, so the first offline start has something to show', async () => {
    const { cache, storage } = fakeCaches();

    await precache(storage);

    expect(storage.open).toHaveBeenCalledWith(CACHE_NAME);
    expect(cache.addAll).toHaveBeenCalledWith(PRECACHE);
    expect(PRECACHE).toContain('/index.html');
  });
});

describe('activating', () => {
  it('uses the dev cache when no build identifier is injected', () => {
    expect(CACHE_NAME).toBe(`${CACHE_PREFIX}dev`);
  });

  it('drops the previous build cache when a new build activates', async () => {
    try {
      vi.stubGlobal('__HOLYDECK_BUILD_ID__', 'build-one');
      vi.resetModules();
      const oldBuild = await import('./service-worker-handlers.js');

      vi.stubGlobal('__HOLYDECK_BUILD_ID__', 'build-two');
      vi.resetModules();
      const newBuild = await import('./service-worker-handlers.js');
      const { storage } = fakeCaches({}, [
        oldBuild.CACHE_NAME,
        newBuild.CACHE_NAME,
        'someone-elses-cache',
      ]);

      expect(oldBuild.CACHE_NAME).toBe(`${CACHE_PREFIX}build-one`);
      expect(newBuild.CACHE_NAME).toBe(`${CACHE_PREFIX}build-two`);
      await expect(newBuild.dropOtherCaches(storage)).resolves.toEqual([oldBuild.CACHE_NAME]);
      expect(storage.delete).toHaveBeenCalledExactlyOnceWith(oldBuild.CACHE_NAME);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it('deletes its own older caches and leaves everything else alone', async () => {
    const { storage } = fakeCaches({}, [CACHE_NAME, 'holydeck-web-v0', 'someone-elses-cache']);

    await expect(dropOtherCaches(storage)).resolves.toEqual(['holydeck-web-v0']);
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith('holydeck-web-v0');
  });
});

describe('responding', () => {
  it('serves a precached response without touching the network', async () => {
    const { storage } = fakeCaches({ '/index.html': cached });
    const fetch = vi.fn(async () => fresh);

    await expect(
      respond({ method: 'GET', url: '/index.html', mode: 'navigate' }, storage, fetch),
    ).resolves.toBe(cached);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('goes to the network for anything it has not cached', async () => {
    const { storage } = fakeCaches();
    const fetch = vi.fn(async () => fresh);
    const request = { method: 'GET', url: '/api/v1/stats', mode: 'cors' };

    await expect(respond(request, storage, fetch)).resolves.toBe(fresh);
    expect(fetch).toHaveBeenCalledWith(request);
  });

  it('never answers a write from the cache', async () => {
    const { cache, storage } = fakeCaches({ '/api/v1/render': cached });
    const fetch = vi.fn(async () => fresh);

    await expect(
      respond({ method: 'POST', url: '/api/v1/render', mode: 'cors' }, storage, fetch),
    ).resolves.toBe(fresh);
    expect(cache.match).not.toHaveBeenCalled();
  });

  it('falls back to the shell when a navigation happens with the network gone', async () => {
    const { storage } = fakeCaches({ '/index.html': cached });
    const fetch = vi.fn(async () => {
      throw new Error('offline');
    });

    await expect(
      respond({ method: 'GET', url: '/service/current', mode: 'navigate' }, storage, fetch),
    ).resolves.toBe(cached);
  });

  it('reports the failure when even the shell has been evicted', async () => {
    const { storage } = fakeCaches();
    const fetch = vi.fn(async () => {
      throw new Error('offline');
    });

    await expect(
      respond({ method: 'GET', url: '/service/current', mode: 'navigate' }, storage, fetch),
    ).rejects.toThrow(/offline/u);
  });

  it('lets a failed data request fail, so the client can say what is missing', async () => {
    const { storage } = fakeCaches();
    const fetch = vi.fn(async () => {
      throw new Error('offline');
    });

    await expect(
      respond({ method: 'GET', url: '/api/v1/stats', mode: 'cors' }, storage, fetch),
    ).rejects.toThrow(/offline/u);
  });
});
