import { readFileSync } from 'node:fs';

import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { LIVE_CLOSE, LIVE_CONTROL_CHANNEL } from '@holydeck/contracts/live';
import { ORDER_PATH } from '@holydeck/contracts/order';
import { CSRF_HEADER, SESSION_PATH, TICKET_PATH } from '@holydeck/contracts/sessions';
import { LOCALES } from '@holydeck/localization/locales';
import { translate } from '@holydeck/localization/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnnouncementElementLike } from './announcements.js';
import type { FetchLike, ResponseLike } from './api.js';
import type { ElementLike } from './control.js';
import type { SocketEventLike, WebSocketLike } from './live-client.js';

interface FakeElement extends ElementLike, AnnouncementElementLike {
  children: ElementLike[];
}

const element = (attributes = ''): FakeElement => ({
  textContent: '',
  hidden: attributes.includes('hidden'),
  disabled: false,
  onclick: null,
  children: [],
  appendChild(child) { this.children.push(child); },
  replaceChildren(...children) { this.children = [...children]; },
  getAttribute: (name) => new RegExp(`${name}="([^"]*)"`, 'u').exec(attributes)?.[1] ?? null,
});

const shell = readFileSync(new URL('./static/index.html', import.meta.url), 'utf8');
const fakeDocument = () => {
  const elements = new Map([...shell.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/gu)]
    .map(([tag, id]) => [id as string, element(tag)]));
  const doc = {
    documentElement: { lang: 'en' },
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: () => element(),
    addEventListener: (_type: string, listener: (event: { key: string }) => void) => { doc.keydown = listener; },
    keydown: (event: { key: string }) => { void event; },
  };
  return {
    doc,
    el(id: string): FakeElement {
      const found = elements.get(id);
      if (found === undefined) throw new Error(`missing test element: ${id}`);
      return found;
    },
  };
};

const data = {
  items: [{ id: 'welcome', label: 'Welcome' }, { id: 'offering', label: 'Offering' }],
  catalogue: [{ id: 'offering-label', name: 'Offering', shortcut: '3' }, { id: 'welcome-label', name: 'Welcome' }],
};
const success = (data: unknown): ResponseLike => ({
  status: 200,
  json: async () => ({ data, meta: { requestId: 'request-1', version: CLIENT_WINDOW.current } }),
});
const refused = (): ResponseLike => ({
  status: 403,
  json: async () => ({ error: { code: 'auth.forbidden', message: 'Refused', requestId: 'request-1' } }),
});
const unreachable = (): never => { throw new TypeError('unreachable'); };

let sockets: FakeSocket[];
class FakeSocket implements WebSocketLike {
  readonly listeners = new Map<string, ((event: SocketEventLike) => void)[]>();
  readyState = 0;
  send = vi.fn();
  close = vi.fn();
  constructor(readonly url: string) { sockets.push(this); }
  addEventListener(type: string, listener: (event: SocketEventLike) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string, event: SocketEventLike = {}): void {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  snapshot(): void {
    this.fire('message', { data: JSON.stringify({
      kind: 'snapshot', channel: LIVE_CONTROL_CHANNEL, stateRevision: 1, sequence: 1, at: '2026-09-22T10:00:00.000Z',
    }) });
  }
}

let view: ReturnType<typeof fakeDocument>;
let fetching: ReturnType<typeof vi.fn<FetchLike>>;
let responses: Map<string, () => ResponseLike | Promise<ResponseLike>>;
let register: ReturnType<typeof vi.fn>;
const load = async () => {
  await import('./main.js');
  await vi.advanceTimersByTimeAsync(0);
};
const socket = () => {
  const opened = sockets.at(-1);
  if (opened === undefined) throw new Error('no socket opened');
  return opened;
};

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  sockets = [];
  view = fakeDocument();
  let tickets = 0;
  responses = new Map([
    [ORDER_PATH, () => success(data)],
    [SESSION_PATH, () => success({ csrf: 'csrf-token' })],
    [TICKET_PATH, () => success({ ticket: `ticket-${++tickets}`, expiresInSeconds: 30 })],
  ]);
  fetching = vi.fn(async (path) => {
    const respond = responses.get(path);
    if (respond === undefined) throw new Error(`unexpected request: ${path}`);
    return respond();
  });
  register = vi.fn().mockResolvedValue({});
  vi.stubGlobal('document', view.doc);
  vi.stubGlobal('navigator', { languages: ['en'], serviceWorker: { register } });
  vi.stubGlobal('location', { origin: 'https://deployment.invalid' });
  vi.stubGlobal('fetch', fetching);
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('loading the operator surface', () => {
  it('renders the real order and uses the returned shortcut catalogue', async () => {
    await load();
    expect(fetching).toHaveBeenCalledWith(ORDER_PATH, {
      headers: { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current) },
    });
    expect(view.el('order-list').children).toHaveLength(2);
    expect(view.el('order-empty').hidden).toBe(true);
    expect(view.el('preview-current').textContent).toBe('Welcome');
    expect(view.el('preview-next').textContent).toBe('Offering');
    view.doc.keydown({ key: '3' });
    expect(view.el('preview-current').textContent).toBe('Offering');
    expect(view.el('properties-value').textContent).toBe('Offering');
    expect(register).toHaveBeenCalledWith('/service-worker.js', { scope: '/' });
  });

  it.each([
    ['refused', refused],
    ['unreachable', unreachable],
    ['unreadable envelope', () => ({ status: 200, json: async () => ({}) })],
    ['null data', () => success(null)],
    ['missing lists', () => success({})],
    ['bad item', () => success({ ...data, items: [null] })],
    ['bad catalogue', () => success({ ...data, catalogue: [{ id: 'x', name: 'Offering', shortcut: 'x' }] })],
    ['empty order', () => success({ items: [], catalogue: [] })],
  ] as const)('renders the empty state when the order is %s', async (_name, respond) => {
    responses.set(ORDER_PATH, respond);
    await load();
    expect(view.el('order-empty').hidden).toBe(false);
    expect(view.el('order-list').children).toEqual([]);
    expect(view.el('preview-empty').hidden).toBe(false);
    expect(view.el('live-next').disabled).toBe(true);
    expect(view.el('live-previous').disabled).toBe(true);
    expect(view.el('status').textContent).toBe(translate('en', 'shell.preparing'));
  });

  it('localizes the shell before a pending order request settles and connects independently', async () => {
    let finish!: (response: ResponseLike) => void;
    responses.set(ORDER_PATH, () => new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal('navigator', { languages: ['de'] });
    await load();
    expect(view.doc.documentElement.lang).toBe('de');
    expect(view.el('status').textContent).toBe(translate('de', 'shell.preparing'));
    expect(sockets).toHaveLength(1);
    finish(success(data));
    await vi.advanceTimersByTimeAsync(0);
    expect(view.el('order-list').children).toHaveLength(2);
    expect(view.el('connection-status').textContent).toBe(translate('de', 'control.connection.connecting'));
  });

  it('still renders when service-worker registration fails', async () => {
    register.mockRejectedValue(new Error('refused'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await load();
    expect(view.el('preview-current').textContent).toBe('Welcome');
    expect(warn).toHaveBeenCalled();
  });

  it('does not request data or open a socket without a document', async () => {
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('navigator', undefined);
    await load();
    expect(fetching).not.toHaveBeenCalled();
    expect(sockets).toEqual([]);
  });
});

describe('the live control connection', () => {
  it.each(LOCALES)('connects with a session ticket and announces loss/regain in %s', async (locale) => {
    vi.stubGlobal('navigator', { languages: [locale] });
    await load();
    expect(fetching).toHaveBeenCalledWith(SESSION_PATH, {
      headers: { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current) },
    });
    expect(fetching).toHaveBeenCalledWith(TICKET_PATH, {
      method: 'POST', headers: {
        [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current), [CSRF_HEADER]: 'csrf-token',
      },
    });
    const url = new URL(socket().url);
    expect(url.origin).toBe('wss://deployment.invalid');
    expect(url.searchParams.get('channel')).toBe(LIVE_CONTROL_CHANNEL);
    expect(url.searchParams.get('ticket')).toBe('ticket-1');
    expect(view.el('connection-status').textContent).toBe(translate(locale, 'control.connection.connecting'));
    socket().fire('open');
    socket().snapshot();
    expect(view.el('connection-status').textContent).toBe(translate(locale, 'control.connection.synchronised'));
    expect(view.el('announce-polite').textContent).toBe('');
    view.el('live-next').onclick?.();
    expect(view.el('connection-status').textContent).toBe(translate(locale, 'control.connection.synchronised'));
    socket().fire('close', { code: 1006 });
    expect(view.el('connection-status').textContent).toBe(translate(locale, 'control.connection.degraded'));
    expect(view.el('announce-assertive').textContent).toBe(translate(locale, 'announce.connection.reconnecting'));
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(2);
    expect(new URL(socket().url).searchParams.get('ticket')).toBe('ticket-2');
    socket().fire('open');
    expect(view.el('connection-status').textContent).toBe(translate(locale, 'control.connection.resuming'));
    socket().snapshot();
    socket().snapshot();
    expect(view.el('connection-status').textContent).toBe(translate(locale, 'control.connection.synchronised'));
    expect(view.el('announce-assertive').textContent).toBe('');
    expect(view.el('announce-polite').textContent).toBe(translate(locale, 'announce.connection.restored'));
    expect(view.el('preview-current').textContent).toBe('Offering');
    expect(fetching.mock.calls.filter(([path]) => path === ORDER_PATH)).toHaveLength(1);
  });

  it.each([
    [SESSION_PATH, refused], [SESSION_PATH, unreachable],
    [SESSION_PATH, () => success(null)], [SESSION_PATH, () => success({})],
    [SESSION_PATH, () => success({ csrf: '' })],
    [TICKET_PATH, refused], [TICKET_PATH, unreachable],
    [TICKET_PATH, () => success(null)], [TICKET_PATH, () => success({})],
    [TICKET_PATH, () => success({ ticket: '' })],
  ] as const)('reports an unusable credential response from %s without opening a socket (%#)', async (path, respond) => {
    responses.set(path, respond);
    await load();
    expect(sockets).toEqual([]);
    expect(view.el('connection-status').textContent).toBe(translate('en', 'control.connection.closed'));
    expect(view.el('announce-assertive').textContent).toBe(translate('en', 'announce.connection.lost'));
    expect(view.el('preview-current').textContent).toBe('Welcome');
    if (path === SESSION_PATH) expect(fetching.mock.calls.some(([url]) => url === TICKET_PATH)).toBe(false);
  });

  it('shows a refused control handshake without retrying', async () => {
    await load();
    socket().fire('close', { code: LIVE_CLOSE.refused, reason: 'diagnostic detail' });
    expect(view.el('connection-status').textContent).toBe(translate('en', 'control.connection.closed'));
    expect(view.el('announce-assertive').textContent).toBe(translate('en', 'announce.connection.lost'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(1);
  });

  it('reports an unsupported browser while still rendering the order', async () => {
    vi.stubGlobal('WebSocket', undefined);
    await load();
    expect(view.el('connection-status').textContent).toBe(translate('en', 'control.connection.closed'));
    expect(view.el('announce-assertive').textContent).toBe(translate('en', 'announce.connection.lost'));
    expect(view.el('preview-current').textContent).toBe('Welcome');
  });
});
