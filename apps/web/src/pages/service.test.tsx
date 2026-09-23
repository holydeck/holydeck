// @vitest-environment happy-dom
// The service route keeps rendering independent from its socket: a refused or unsupported live channel
// is visible to the operator, while the order that was already safe to read remains available.

import { render, screen, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { LIVE_CLOSE, LIVE_CONTROL_CHANNEL } from '@holydeck/contracts/live';
import { ORDER_PATH } from '@holydeck/contracts/order';
import { TICKET_PATH, type SessionView } from '@holydeck/contracts/sessions';

import { resetAppState, session } from '../app-state.js';
import { AppShell } from '../components/app-shell.js';
import { setFetching } from '../request.js';
import { ServicePage } from './service.js';

import type { FetchLike } from '../api.js';
import type { SocketEventLike, WebSocketLike } from '../live-client.js';

const order = {
  items: [{ id: 'welcome', label: 'Welcome' }],
  catalogue: [],
};

const reply = (data: unknown) => ({
  status: 200,
  json: async (): Promise<unknown> => ({ data, meta: { requestId: 'request-1', version: CLIENT_WINDOW.current } }),
});

let sockets: FakeSocket[];
class FakeSocket implements WebSocketLike {
  readonly listeners = new Map<string, ((event: SocketEventLike) => void)[]>();
  readyState = 0;
  constructor(readonly url: string) { sockets.push(this); }
  send(): void {}
  close(): void { this.readyState = 3; }
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: SocketEventLike) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: 'open' | 'message' | 'close' | 'error', event: SocketEventLike = {}): void {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const renderPage = () => render(<AppShell><ServicePage id="sunday" /></AppShell>);

describe('ServicePage', () => {
  beforeEach(() => {
    resetAppState();
    sockets = [];
    session.value = { csrf: 'c'.repeat(43), permissions: [], slots: [] } as unknown as SessionView;
    setFetching(vi.fn<FetchLike>(async (path) => {
      if (path === ORDER_PATH) return reply(order);
      if (path === TICKET_PATH) return reply({ ticket: 'ticket-one', expiresInSeconds: 30 });
      throw new Error(`unexpected request: ${path}`);
    }));
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  it('keeps its rendered order after a refused handshake and never retries it', async () => {
    renderPage();
    await screen.findByRole('button', { name: 'Show Welcome' });
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(new URL(sockets[0]?.url ?? '').searchParams.get('channel')).toBe(LIVE_CONTROL_CHANNEL);

    sockets[0]?.fire('close', { code: LIVE_CLOSE.refused, reason: 'refused' });
    await waitFor(() => expect(document.getElementById('connection-status')?.textContent).toBe('Live connection closed.'));
    expect(document.getElementById('announce-assertive')?.textContent).toBe(
      'Connection lost. Your last typed text is safe. Editing is paused while we reconnect.',
    );
    expect(sockets).toHaveLength(1);
    expect(document.getElementById('preview-current')?.textContent).toBe('Welcome');
  });

  it('reports an unsupported browser while still rendering the order', async () => {
    vi.stubGlobal('WebSocket', undefined);
    renderPage();

    await screen.findByRole('button', { name: 'Show Welcome' });
    await waitFor(() => expect(document.getElementById('connection-status')?.textContent).toBe('Live connection closed.'));
    expect(document.getElementById('announce-assertive')?.textContent).toBe(
      'Connection lost. Your last typed text is safe. Editing is paused while we reconnect.',
    );
    expect(sockets).toEqual([]);
  });
});
