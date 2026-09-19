import { type ControlDocumentLike, renderControl } from './control.js';
import {
  type ServiceWorkerContainerLike,
  registerServiceWorker,
} from './register-service-worker.js';
import { type ShellDocumentLike, renderShell } from './shell.js';

const { document, navigator } = globalThis as {
  document?: ShellDocumentLike & ControlDocumentLike;
  navigator?: { languages?: readonly string[]; serviceWorker?: ServiceWorkerContainerLike };
};

// Before anything asynchronous: the served HTML is English, and a device that asked for another
// language should not read a sentence in the wrong one while the client starts up.
if (document !== undefined) {
  const locale = renderShell(document, navigator?.languages ?? []);
  // No order-reading route exists yet — only T52 and T82 do, which is all this surface depends on — so
  // it starts empty and every region renders its honest empty state until a later task wires it up.
  renderControl(document, locale, { items: [], catalogue: [] });
}

void registerServiceWorker(navigator?.serviceWorker, '/service-worker.js', (error) => {
  console.warn('HolyDeck will run online only: the service worker was refused', error);
});
