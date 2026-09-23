// @vitest-environment happy-dom

import { act, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import { successEnvelope } from '@holydeck/contracts/http';
import type { ServiceItem } from '@holydeck/contracts/services';
import type { SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';
import { session } from '../app-state.js';
import { ToastRegion, toasts } from '../components/toast.js';
import { setFetching } from '../request.js';
import { drift, resetWorkspace, selection, service } from '../state/workspace-store.js';
import { OrderItem } from './OrderItem.js';
import type { ServiceView } from './service-data.js';

const me: AccountRecord = {
  id: 'GLkQ5wEtQEy5PfN2Zr9m7A', name: 'andru', displayName: 'Andru Example', role: 'admin',
  createdAt: '2026-09-13T09:30:00.000Z', controlPresentation: true, disabled: false,
};
const csrf = 'c'.repeat(43);

const signedIn = (permissions = ['services.manage']): SessionView => ({
  account: me, actor: `account:${me.id}`, permissions,
  startedAt: '2026-09-13T09:30:00.000Z', lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z', rotation: 'authentication', csrf, slots: [],
});

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });
const noDrift = reply(200, successEnvelope([], 'r-drift'));

const record = (itemIds: readonly string[]) => ({
  stamp: {
    id: 's1', kind: 'service', schemaVersion: 1, createdAt: '2026-09-27T10:00:00.000Z', createdBy: 'account:andru',
    updatedAt: '2026-09-27T10:00:01.000Z', updatedBy: 'account:andru',
  },
  title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming',
  sections: [{ id: 'sec', name: 'Welcome', items: itemIds.map((id) => ({
    id, kind: 'custom-slide', title: id === 'a' ? 'Song A' : 'Song B', enabled: true, content: undefined,
  })) }],
});

const itemA: ServiceItem = { id: 'a', kind: 'custom-slide', title: 'Song A', enabled: true, content: undefined };
const itemB: ServiceItem = {
  id: 'b', kind: 'song', title: 'Song B', enabled: false, content: { id: 'c1', revision: 3, hash: undefined },
};

const view: ServiceView = {
  id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', revision: 'r0',
  sections: [{ id: 'sec', name: 'Welcome', items: [itemA, itemB] }],
};

const fakeFetch = (map: Record<string, ReturnType<typeof reply> | (() => Promise<ReturnType<typeof reply>> | ReturnType<typeof reply>)>, calls: string[] = []): FetchLike =>
  async (url, init) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    calls.push(key);
    const response = map[key];
    if (response === undefined) throw new Error(`No reply for ${key}`);
    return typeof response === 'function' ? await response() : response;
  };

// happy-dom's elements have no `ondragover`/`ondrop`/`ondragstart` properties, so Preact registers those
// handlers under their JSX casing ("DragOver", ...) rather than the lowercase DOM type a browser fires.
// Dispatching that casing reaches the very handlers a real drag would; the harness journey drags for real.
const drag = (target: Element, type: 'DragStart' | 'DragOver' | 'Drop', dataTransfer: object): Event => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  target.dispatchEvent(event);
  return event;
};

beforeEach(() => {
  resetWorkspace();
  session.value = signedIn();
  service.value = view;
  toasts.value = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OrderItem', () => {
  it('moves an item up with one reorder request and stays pending until it answers', async () => {
    const calls: string[] = [];
    let resolveReorder: (value: ReturnType<typeof reply>) => void = () => {};
    setFetching(fakeFetch({
      'POST /api/v1/services/s1/sections/sec/items/reorder': async () => new Promise((resolve) => { resolveReorder = resolve; }),
      'GET /api/v1/services/s1/content-drift': noDrift,
    }, calls));
    render(<OrderItem sectionId="sec" item={itemB} index={1} total={2} />);

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Song B' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Up' }));

    await vi.waitFor(() => expect(calls).toEqual(['POST /api/v1/services/s1/sections/sec/items/reorder']));
    expect(screen.getByText('Song B').closest('li')?.getAttribute('aria-busy')).toBe('true');

    await act(async () => {
      resolveReorder(reply(200, successEnvelope(record(['b', 'a']), 'r2')));
    });
    await vi.waitFor(() => {
      expect(screen.getByText('Song B').closest('li')?.getAttribute('aria-busy')).toBeNull();
    });
  });

  it('removes an item, offers Undo, and restores it at the same index on Undo', async () => {
    const calls: string[] = [];
    setFetching(fakeFetch({
      'DELETE /api/v1/services/s1/items/b': reply(200, successEnvelope(record(['a']), 'r2')),
      'POST /api/v1/services/s1/sections/sec/items': reply(200, successEnvelope(record(['a', 'b']), 'r3')),
      'POST /api/v1/services/s1/sections/sec/items/reorder': reply(200, successEnvelope(record(['a', 'b']), 'r4')),
      'GET /api/v1/services/s1/content-drift': noDrift,
    }, calls));
    render(<><OrderItem sectionId="sec" item={itemB} index={1} total={2} /><ToastRegion /></>);

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Song B' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await screen.findByText('Item removed.');

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    await vi.waitFor(() => expect(calls).toEqual([
      'DELETE /api/v1/services/s1/items/b',
      'GET /api/v1/services/s1/content-drift',
      'POST /api/v1/services/s1/sections/sec/items',
      'GET /api/v1/services/s1/content-drift',
      'POST /api/v1/services/s1/sections/sec/items/reorder',
      'GET /api/v1/services/s1/content-drift',
    ]));
  });

  it('shows Disabled as visible text, not only as a color', () => {
    setFetching(fakeFetch({}));
    render(<OrderItem sectionId="sec" item={itemB} index={1} total={2} />);

    const disabled = screen.getByText('Disabled');
    expect(disabled.tagName).toBe('SPAN');
    expect(disabled.className).toContain('is-disabled');
  });

  it('disables every action when the workspace is read-only', () => {
    service.value = { ...view, state: 'completed' };
    setFetching(fakeFetch({}));
    render(<OrderItem sectionId="sec" item={itemB} index={1} total={2} />);

    expect((screen.getByRole('button', { name: 'Actions for Song B' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Drag Song B' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a kind label and the pinned revision', () => {
    setFetching(fakeFetch({}));
    render(<OrderItem sectionId="sec" item={itemB} index={1} total={2} />);

    expect(screen.getByText('Song')).toBeTruthy();
    expect(screen.getByText('Revision 3')).toBeTruthy();
  });

  it('shows the drift notice for a drifted item, never firing on its own', () => {
    drift.value = [{ itemId: 'b', latestRevision: 4 }];
    setFetching(fakeFetch({}));
    render(<OrderItem sectionId="sec" item={itemB} index={1} total={2} />);

    expect(screen.getByText('A newer revision is available')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update to revision 4' })).toBeTruthy();
  });

  it('shows actions as a plain disclosure that Escape closes, returning focus to Actions', () => {
    setFetching(fakeFetch({}));
    render(<OrderItem sectionId="sec" item={itemA} index={0} total={2} />);

    const actions = screen.getByRole('button', { name: 'Actions for Song A' });
    fireEvent.click(actions);
    expect(actions.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByRole('menu')).toBeNull();
    const duplicate = screen.getByRole('button', { name: 'Duplicate' });
    fireEvent.keyDown(duplicate, { key: 'Tab' });
    expect(actions.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(duplicate, { key: 'Escape' });

    expect(screen.queryByRole('button', { name: 'Duplicate' })).toBeNull();
    expect(document.activeElement).toBe(actions);
  });

  it('selects an existing item from its title, remembering it in the address', () => {
    setFetching(fakeFetch({}));
    globalThis.history.replaceState(null, '', '/services/s1?tab=x');
    render(<OrderItem sectionId="sec" item={itemA} index={0} total={2} />);

    const title = screen.getByRole('button', { name: 'Song A' });
    expect(title.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(title);

    expect(selection.value).toEqual({ itemId: 'a' });
    expect(title.getAttribute('aria-pressed')).toBe('true');
    expect(new URLSearchParams(globalThis.location.search).get('item')).toBe('a');
    expect(new URLSearchParams(globalThis.location.search).get('tab')).toBe('x');
  });

  it('reorders an item dropped on another row with the same request the keyboard move sends', async () => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    setFetching(async (url, init) => {
      const key = `${init.method ?? 'GET'} ${url}`;
      calls.push(key);
      if (init.body !== undefined) bodies.push(JSON.parse(init.body as string));
      if (key === 'POST /api/v1/services/s1/sections/sec/items/reorder') return reply(200, successEnvelope(record(['b', 'a']), 'r2'));
      if (key === 'GET /api/v1/services/s1/content-drift') return noDrift;
      throw new Error(`No reply for ${key}`);
    });
    render(<><OrderItem sectionId="sec" item={itemA} index={0} total={2} /><OrderItem sectionId="sec" item={itemB} index={1} total={2} /></>);

    const data = new Map<string, string>();
    const dataTransfer = { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '', dropEffect: 'none', effectAllowed: 'all' };
    drag(screen.getByRole('button', { name: 'Drag Song B' }), 'DragStart', dataTransfer);
    const rowA = document.getElementById('workspace-item-a') as HTMLElement;
    expect(drag(rowA, 'DragOver', dataTransfer).defaultPrevented).toBe(true);
    expect(dataTransfer.dropEffect).toBe('move');
    drag(rowA, 'Drop', dataTransfer);

    await vi.waitFor(() => expect(calls).toContain('POST /api/v1/services/s1/sections/sec/items/reorder'));
    expect(bodies[0]).toEqual({ itemIds: ['b', 'a'] });
  });

  it('opens Move To… from the keyboard and returns focus to Actions on Escape', () => {
    setFetching(fakeFetch({}));
    render(<OrderItem sectionId="sec" item={itemB} index={1} total={2} />);

    const actions = screen.getByRole('button', { name: 'Actions for Song B' });
    fireEvent.click(actions);
    fireEvent.click(screen.getByRole('button', { name: 'Move To…' }));

    const dialog = screen.getByRole('dialog', { name: 'Move To…' });
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(actions);
  });
});
