import { LIVE_CONTROL_CHANNEL } from '@holydeck/contracts/live';
import { ORDER_PATH } from '@holydeck/contracts/order';
import { isRecord, parseObject } from '@holydeck/contracts/problems';
import { SESSION_PATH, TICKET_PATH } from '@holydeck/contracts/sessions';
import { SHORTCUT_KEYS } from '@holydeck/contracts/slide-labels';
import { translate } from '@holydeck/localization/messages';

import { type AnnouncementDocumentLike, announceConnection, createAnnouncer } from './announcements.js';
import { ask, type FetchLike } from './api.js';
import { type ControlData, type ControlDocumentLike, renderControl } from './control.js';
import { createLiveClient, detectLiveSocket, type LiveSocketGlobalLike } from './live-client.js';
import {
  type ServiceWorkerContainerLike,
  registerServiceWorker,
} from './register-service-worker.js';
import { type ShellDocumentLike, renderShell } from './shell.js';

const { document, navigator, location } = globalThis as {
  document?: ShellDocumentLike & ControlDocumentLike & AnnouncementDocumentLike;
  navigator?: { languages?: readonly string[]; serviceWorker?: ServiceWorkerContainerLike };
  location?: { origin: string };
};

const fetching: FetchLike = (path, init) => globalThis.fetch(path, init);

const readControlData = (value: unknown) => parseObject<ControlData>(value, 'order', (reader) => ({
  items: reader.parsedList('items', (item, path) => parseObject(item, path, (fields) => ({
    id: fields.text('id'),
    label: fields.text('label'),
  }))),
  catalogue: reader.parsedList('catalogue', (entry, path) => parseObject(entry, path, (fields) => ({
    id: fields.text('id'),
    name: fields.text('name'),
    shortcut: fields.names.includes('shortcut') ? fields.choice('shortcut', SHORTCUT_KEYS) : undefined,
  }))),
}));

// Before anything asynchronous: the served HTML is English, and a device that asked for another
// language should not read a sentence in the wrong one while the client starts up.
if (document !== undefined) {
  const locale = renderShell(document, navigator?.languages ?? []);
  void ask(ORDER_PATH, fetching).then((answer) => {
    const parsed = answer.ok ? readControlData(answer.data) : undefined;
    renderControl(document, locale, parsed?.ok ? parsed.value : { items: [], catalogue: [] });
  });

  const live = createLiveClient({
    channel: LIVE_CONTROL_CHANNEL,
    origin: location?.origin ?? '',
    open: detectLiveSocket(globalThis as LiveSocketGlobalLike),
    credentials: async () => {
      const session = await ask(SESSION_PATH, fetching);
      if (!session.ok || !isRecord(session.data) || typeof session.data.csrf !== 'string' || session.data.csrf === '') {
        return undefined;
      }
      const issued = await ask(TICKET_PATH, fetching, { method: 'POST', csrf: session.data.csrf });
      if (!issued.ok || !isRecord(issued.data) || typeof issued.data.ticket !== 'string' || issued.data.ticket === '') {
        return undefined;
      }
      return { kind: 'ticket', ticket: issued.data.ticket };
    },
  });
  const indicator = document.getElementById('connection-status');
  live.onStatus((status) => {
    if (indicator !== null) indicator.textContent = translate(locale, `control.connection.${status.state}`);
  });
  announceConnection(live, createAnnouncer(document), locale);
  void live.connect();
}

void registerServiceWorker(navigator?.serviceWorker, '/service-worker.js', (error) => {
  console.warn('HolyDeck will run online only: the service worker was refused', error);
});
