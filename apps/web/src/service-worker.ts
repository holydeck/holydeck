import {
  type CacheStorageLike,
  type RequestLike,
  type ResponseLike,
  dropOtherCaches,
  precache,
  respond,
} from './service-worker-handlers.js';

interface ExtendableEventLike {
  waitUntil(work: Promise<unknown>): void;
}

interface FetchEventLike {
  readonly request: RequestLike;
  respondWith(response: Promise<ResponseLike>): void;
}

interface ServiceWorkerScopeLike {
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void;
  skipWaiting(): Promise<void>;
  readonly clients: { claim(): Promise<void> };
  readonly caches: CacheStorageLike;
  fetch(request: RequestLike): Promise<ResponseLike>;
}

// The service worker global scope is not the DOM and not Node; this narrow view is what the handlers
// need, so the project does not take a dependency on a whole ambient library to get three types.
const scope = globalThis as unknown as ServiceWorkerScopeLike;

// Taking over immediately is right while the client is one shell. Prompting an operator before a
// mid-service update lands is owed to the presenter work, which knows when it is safe to reload.
scope.addEventListener('install', (event) => {
  event.waitUntil(precache(scope.caches).then(() => scope.skipWaiting()));
});

scope.addEventListener('activate', (event) => {
  event.waitUntil(dropOtherCaches(scope.caches).then(() => scope.clients.claim()));
});

scope.addEventListener('fetch', (event) => {
  event.respondWith(respond(event.request, scope.caches, (request) => scope.fetch(request)));
});
