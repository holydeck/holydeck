// The entry point owns browser-wide lifetimes only: language, history, the mounting root, session clock
// and offline registration. Pages own their data and connections, so leaving a route also leaves the
// resources that only made sense while it was visible.

import { effect } from '@preact/signals';
import { render } from 'preact';

import { App } from './app.js';
import { locale } from './app-state.js';
import {
  type ServiceWorkerContainerLike,
  registerServiceWorker,
} from './register-service-worker.js';
import { startRouter } from './router.js';
import { boot } from './request.js';
import { startSessionTimer } from './session-timer.js';

/** Starts the mounted application and returns the browser-wide lifetimes its caller can stop. */
export function start(win: Window): () => void {
  const root = win.document.getElementById('app');
  if (root === null) return () => undefined;
  const stopRouter = startRouter(win);
  const stopLocale = effect(() => {
    win.document.documentElement.lang = locale.value;
  });
  root.replaceChildren();
  render(<App />, root);
  void boot();
  const stopSessionTimer = startSessionTimer();
  return (): void => {
    stopSessionTimer();
    stopLocale();
    stopRouter();
    render(null, root);
  };
}

const browser = globalThis as {
  document?: Document;
  navigator?: { serviceWorker?: ServiceWorkerContainerLike };
  window?: Window;
};

if (browser.document !== undefined && browser.window !== undefined) void start(browser.window);

void registerServiceWorker(browser.navigator?.serviceWorker, '/service-worker.js', (error) => {
  console.warn('HolyDeck will run online only: the service worker was refused', error);
});
