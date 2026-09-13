import {
  type ServiceWorkerContainerLike,
  registerServiceWorker,
} from './register-service-worker.js';
import { type ShellDocumentLike, renderShell } from './shell.js';

const { document, navigator } = globalThis as {
  document?: ShellDocumentLike;
  navigator?: { languages?: readonly string[]; serviceWorker?: ServiceWorkerContainerLike };
};

// Before anything asynchronous: the served HTML is English, and a device that asked for another
// language should not read a sentence in the wrong one while the client starts up.
if (document !== undefined) renderShell(document, navigator?.languages ?? []);

void registerServiceWorker(navigator?.serviceWorker, '/service-worker.js', (error) => {
  console.warn('HolyDeck will run online only: the service worker was refused', error);
});
