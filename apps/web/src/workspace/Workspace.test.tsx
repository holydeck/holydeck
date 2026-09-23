// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type AccountRecord } from '@holydeck/contracts/accounts';
import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import { type SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';

import { App } from '../app.js';
import { resetAppState, session } from '../app-state.js';
import { setFetching } from '../request.js';
import { currentPath } from '../router.js';
import { resetWorkspace, rightTab, selection } from '../state/workspace-store.js';

const csrf = 'c'.repeat(43);
const me: AccountRecord = {
  id: 'GLkQ5wEtQEy5PfN2Zr9m7A', name: 'andru', displayName: 'Andru Example', role: 'admin',
  createdAt: '2026-09-13T09:30:00.000Z', controlPresentation: true, disabled: false,
};

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const signedIn = (permissions = ['services.manage']): SessionView => ({
  account: me, actor: `account:${me.id}`, permissions,
  startedAt: '2026-09-13T09:30:00.000Z', lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z', rotation: 'authentication', csrf, slots: [],
});

const record = (id: string, itemIds: string[]) => ({
  stamp: {
    id, kind: 'service', schemaVersion: 1, createdAt: '2026-09-27T10:00:00.000Z', createdBy: 'account:andru',
    updatedAt: '2026-09-27T10:00:00.000Z', updatedBy: 'account:andru',
  },
  title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming',
  sections: [{ id: 'sec', name: 'Welcome', items: itemIds.map((itemId) => ({
    id: itemId, kind: 'custom-slide', title: itemId, enabled: true, content: undefined,
  })) }],
});

const noDrift = reply(200, successEnvelope([], 'r-drift'));

const fakeFetch = (map: Record<string, ReturnType<typeof reply> | (() => ReturnType<typeof reply>)>, calls: string[] = []): FetchLike =>
  async (url, init) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    calls.push(key);
    const response = map[key];
    if (response === undefined) throw new Error(`No reply for ${key}`);
    return typeof response === 'function' ? response() : response;
  };

const renderAt = async (path: string): Promise<void> => {
  history.pushState({}, '', path);
  currentPath.value = path;
  render(<App />);
  await screen.findByRole('heading', { level: 1, name: 'Sunday' });
};

beforeEach(() => {
  resetAppState();
  resetWorkspace();
  session.value = signedIn();
});

describe('the service workspace', () => {
  it('lays out order, editor and details, and remembers the right tab', async () => {
    setFetching(fakeFetch({
      'GET /api/v1/services/s1': reply(200, successEnvelope(record('s1', ['a']), 'r1')),
      'GET /api/v1/services/s1/content-drift': noDrift,
    }));
    await renderAt('/services/s1');

    expect(await screen.findByRole('navigation', { name: 'Order' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Service' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Library' }));
    await vi.waitFor(() => {
      expect(globalThis.localStorage.getItem('holydeck.workspace.rightTab')).toBe('library');
    });
  });

  it('keeps an editor mounted when a bottom tab hides it', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      media: query, matches: false,
      addEventListener: () => undefined, removeEventListener: () => undefined,
    }));
    setFetching(fakeFetch({
      'GET /api/v1/services/s1': reply(200, successEnvelope(record('s1', ['a']), 'r1')),
      'GET /api/v1/services/s1/content-drift': noDrift,
    }));
    await renderAt('/services/s1');

    fireEvent.click(screen.getByRole('tab', { name: 'Editor' }));
    const editor = await screen.findByRole('textbox', { name: 'Editor' }) as HTMLTextAreaElement;
    fireEvent.input(editor, { target: { value: 'half-typed' } });
    expect(editor.value).toBe('half-typed');

    fireEvent.click(screen.getByRole('tab', { name: 'Library' }));
    expect(editor.value).toBe('half-typed');

    fireEvent.click(screen.getByRole('tab', { name: 'Order' }));
    expect(editor.value).toBe('half-typed');

    vi.unstubAllGlobals();
  });

  it('goes read-only offline and re-checks when back online', async () => {
    const calls: string[] = [];
    let loads = 0;
    setFetching(fakeFetch({
      'GET /api/v1/services/s1': () => { loads += 1; return reply(200, successEnvelope(record('s1', ['a']), `r${loads}`)); },
      'GET /api/v1/services/s1/content-drift': noDrift,
    }, calls));
    await renderAt('/services/s1');
    expect(loads).toBe(1);

    globalThis.dispatchEvent(new Event('offline'));
    expect(await screen.findByText('Connection lost. Your last typed text is safe. Editing is paused while we reconnect.')).toBeTruthy();

    globalThis.dispatchEvent(new Event('online'));
    expect(await screen.findByText('Back online. Checking for newer changes…')).toBeTruthy();

    await vi.waitFor(() => expect(loads).toBe(2));
  });

  it('keeps a half-typed edit mounted across a reconnect, and ends up idle', async () => {
    let loads = 0;
    setFetching(fakeFetch({
      'GET /api/v1/services/s1': () => { loads += 1; return reply(200, successEnvelope(record('s1', ['a']), `r${loads}`)); },
      'GET /api/v1/services/s1/content-drift': noDrift,
    }));
    await renderAt('/services/s1');

    fireEvent.click(screen.getByRole('tab', { name: 'Editor' }));
    const editor = await screen.findByRole('textbox', { name: 'Editor' }) as HTMLTextAreaElement;
    fireEvent.input(editor, { target: { value: 'half-typed' } });

    globalThis.dispatchEvent(new Event('offline'));
    globalThis.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(loads).toBe(2));

    await vi.waitFor(() => {
      expect(document.querySelector('[role="status"]')?.textContent).toBe('');
    });
    expect(editor.value).toBe('half-typed');
  });

  it('goes back offline, not idle, when the reconnect check fails', async () => {
    setFetching(fakeFetch({
      'GET /api/v1/services/s1': reply(200, successEnvelope(record('s1', ['a']), 'r1')),
      'GET /api/v1/services/s1/content-drift': noDrift,
    }));
    await renderAt('/services/s1');

    setFetching(fakeFetch({
      'GET /api/v1/services/s1': reply(500, errorEnvelope('client.network_unreachable', 'still down', 'r2')),
    }));
    globalThis.dispatchEvent(new Event('offline'));
    globalThis.dispatchEvent(new Event('online'));

    await vi.waitFor(() => {
      expect(document.querySelector('[role="status"]')?.textContent).toBe('Connection lost. Your last typed text is safe. Editing is paused while we reconnect.');
    });
  });

  it('restores ?item= selection', async () => {
    setFetching(fakeFetch({
      'GET /api/v1/services/s1': reply(200, successEnvelope(record('s1', ['a', 'b']), 'r1')),
      'GET /api/v1/services/s1/content-drift': noDrift,
    }));
    await renderAt('/services/s1?item=b');

    await vi.waitFor(() => expect(selection.value.itemId).toBe('b'));
  });

  it('opens the Reading editor above the preview for a selected reading', async () => {
    const withReading = record('s1', ['a']);
    const sections = [{ ...withReading.sections[0], items: [{
      id: 'r', kind: 'reading', title: 'John 3', enabled: true, content: undefined,
      body: { kind: 'reading', translation: 'KJV', compare: [], book: 'JHN', chapter: 3, verses: '16' },
    }] }];
    setFetching(fakeFetch({
      'GET /api/v1/services/s1': reply(200, successEnvelope({ ...withReading, sections }, 'r1')),
      'GET /api/v1/services/s1/content-drift': noDrift,
    }));
    await renderAt('/services/s1?item=r');

    expect(await screen.findByRole('heading', { name: 'Reading', hidden: true })).toBeTruthy();
  });

  it('shows the missing state with a link back to Services', async () => {
    setFetching(fakeFetch({
      'GET /api/v1/services/s1': reply(404, errorEnvelope('resource.not_found', 'none', 'r1')),
    }));
    history.pushState({}, '', '/services/s1');
    currentPath.value = '/services/s1';
    render(<App />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe("This service no longer exists or you can't open it.");
    expect(screen.getByRole('link', { name: 'Back to Services' }).getAttribute('href')).toBe('/services');
  });

  it('shows the load error state with Try Again', async () => {
    setFetching(fakeFetch({
      'GET /api/v1/services/s1': reply(500, errorEnvelope('client.network_unreachable', 'offline', 'r1')),
    }));
    history.pushState({}, '', '/services/s1');
    currentPath.value = '/services/s1';
    render(<App />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe("We couldn't load this workspace. Check your connection and try again.");
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeTruthy();
  });

  it('shows the read-only banner once completed, and no join note', async () => {
    setFetching(fakeFetch({
      'GET /api/v1/services/s1': reply(200, successEnvelope({ ...record('s1', ['a']), state: 'completed' }, 'r1')),
      'GET /api/v1/services/s1/content-drift': noDrift,
    }));
    await renderAt('/services/s1');

    expect(screen.getByRole('note').textContent).toBe('This service has been presented. Its delivered order is kept as it was.');
    expect(screen.queryByText('Guests can join while this service is Presenting.')).toBeNull();
  });

  it('shows the join note while presenting, and no read-only banner', async () => {
    setFetching(fakeFetch({
      'GET /api/v1/services/s1': reply(200, successEnvelope({ ...record('s1', ['a']), state: 'presenting' }, 'r1')),
      'GET /api/v1/services/s1/content-drift': noDrift,
    }));
    await renderAt('/services/s1');

    expect(screen.getByText('Guests can join while this service is Presenting.')).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('shows the empty state with Add Content, which switches to the Library tab', async () => {
    rightTab.value = 'properties';
    setFetching(fakeFetch({
      'GET /api/v1/services/s1': reply(200, successEnvelope(record('s1', []), 'r1')),
      'GET /api/v1/services/s1/content-drift': noDrift,
    }));
    await renderAt('/services/s1');

    expect(screen.getByText('This service has no items yet. Use the Library tab to add the first one.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add Content' }));

    expect(rightTab.value).toBe('library');
    expect(screen.getByRole('tab', { name: 'Library', selected: true })).toBeTruthy();
    expect(document.getElementById('workspace-panel-library')?.hidden).toBe(false);
    expect(await screen.findByRole('searchbox', { name: 'Search content' })).toBeTruthy();
  });
});
