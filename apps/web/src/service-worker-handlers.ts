export interface ResponseLike {
  readonly body?: unknown;
}

export interface RequestLike {
  readonly method: string;
  readonly url: string;
  readonly mode?: string;
}

export interface CacheLike {
  match(url: string): Promise<ResponseLike | undefined>;
  addAll(urls: readonly string[]): Promise<void>;
  put(url: string, response: ResponseLike): Promise<void>;
}

export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

export const CACHE_PREFIX = 'holydeck-web-';

// Revisioning the cache per build is owned by the cache-revisioning work; until then the name is
// bumped by hand, and activating deletes every earlier one.
export const CACHE_NAME = `${CACHE_PREFIX}v1`;

export const SHELL = '/index.html';

export const PRECACHE = [
  '/',
  SHELL,
  '/main.js',
  '/app.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

export async function precache(caches: CacheStorageLike): Promise<void> {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(PRECACHE);
}

export async function dropOtherCaches(caches: CacheStorageLike): Promise<string[]> {
  const stale = (await caches.keys()).filter(
    (name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME,
  );
  // Only this client's own caches: the origin may hold caches that belong to someone else.
  await Promise.all(stale.map((name) => caches.delete(name)));
  return stale;
}

export async function respond(
  request: RequestLike,
  caches: CacheStorageLike,
  fetch: (request: RequestLike) => Promise<ResponseLike>,
): Promise<ResponseLike> {
  // A write is never answered from a cache, and never cached.
  if (request.method !== 'GET') return fetch(request);
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(request.url);
  if (hit !== undefined) return hit;
  try {
    return await fetch(request);
  } catch (error) {
    // Offline, a navigation gets the shell and the client explains itself; a data request must
    // fail, so the client can say which part of the service is missing rather than show stale text.
    if (request.mode !== 'navigate') throw error;
    const shell = await cache.match(SHELL);
    if (shell === undefined) throw error;
    return shell;
  }
}
