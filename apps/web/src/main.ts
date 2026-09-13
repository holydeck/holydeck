import {
  type ServiceWorkerContainerLike,
  registerServiceWorker,
} from './register-service-worker.js';

const { navigator } = globalThis as { navigator?: { serviceWorker?: ServiceWorkerContainerLike } };

void registerServiceWorker(navigator?.serviceWorker, '/service-worker.js', (error) => {
  console.warn('HolyDeck will run online only: the service worker was refused', error);
});
