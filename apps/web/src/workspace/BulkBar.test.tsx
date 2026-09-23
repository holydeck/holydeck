// @vitest-environment happy-dom

import { act, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import { successEnvelope } from '@holydeck/contracts/http';
import type { ServiceItem } from '@holydeck/contracts/services';
import type { SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';
import { session } from '../app-state.js';
import { setFetching } from '../request.js';
import { bulkSelecting, bulkSelection, resetWorkspace, service } from '../state/workspace-store.js';
import { BulkBar } from './BulkBar.js';
import type { ServiceView } from './service-data.js';

const me: AccountRecord = {
  id: 'GLkQ5wEtQEy5PfN2Zr9m7A', name: 'andru', displayName: 'Andru Example', role: 'admin',
  createdAt: '2026-09-13T09:30:00.000Z', controlPresentation: true, disabled: false,
};
const csrf = 'c'.repeat(43);

const signedIn = (): SessionView => ({
  account: me, actor: `account:${me.id}`, permissions: ['services.manage'],
  startedAt: '2026-09-13T09:30:00.000Z', lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z', rotation: 'authentication', csrf, slots: [],
});

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });
const noDrift = reply(200, successEnvelope([], 'r-drift'));

const record = (sections: readonly { id: string; name: string; itemIds: readonly string[] }[]) => ({
  stamp: {
    id: 's1', kind: 'service', schemaVersion: 1, createdAt: '2026-09-27T10:00:00.000Z', createdBy: 'account:andru',
    updatedAt: '2026-09-27T10:00:01.000Z', updatedBy: 'account:andru',
  },
  title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming',
  sections: sections.map((section) => ({
    id: section.id, name: section.name,
    items: section.itemIds.map((id) => ({ id, kind: 'custom-slide', title: id, enabled: true, content: undefined })),
  })),
});

const itemA: ServiceItem = { id: 'a', kind: 'custom-slide', title: 'Song A', enabled: true, content: undefined };
const itemB: ServiceItem = { id: 'b', kind: 'custom-slide', title: 'Song B', enabled: true, content: undefined };

const view: ServiceView = {
  id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', revision: 'r0',
  sections: [{ id: 'sec', name: 'Welcome', items: [itemA, itemB] }],
};

const fakeFetch = (
  map: Record<string, ReturnType<typeof reply> | (() => Promise<ReturnType<typeof reply>> | ReturnType<typeof reply>)>,
  calls: string[] = [],
): FetchLike =>
  async (url, init) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    calls.push(key);
    const response = map[key];
    if (response === undefined) throw new Error(`No reply for ${key}`);
    return typeof response === 'function' ? await response() : response;
  };

const select = (...ids: readonly string[]): void => {
  bulkSelection.value = new Set(ids);
};

beforeEach(() => {
  resetWorkspace();
  session.value = signedIn();
  service.value = view;
  bulkSelecting.value = true;
  select('a', 'b');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('BulkBar', () => {
  it('shows how many items are selected, live-updating as the selection changes', () => {
    setFetching(fakeFetch({}));
    const { rerender } = render(<BulkBar view={view} />);

    expect(screen.getByRole('region', { name: 'Bulk actions' })).toBeTruthy();
    expect(screen.getByText('2 selected')).toBeTruthy();

    select('a');
    rerender(<BulkBar view={view} />);
    expect(screen.getByText('1 selected')).toBeTruthy();
  });

  it('shows partial success as partial and names the refused item and its reason', async () => {
    const calls: string[] = [];
    setFetching(fakeFetch({
      'POST /api/v1/services/s1/items/a/duplicate': reply(200, successEnvelope(record([{ id: 'sec', name: 'Welcome', itemIds: ['a', 'a-copy', 'b'] }]), 'r2')),
      'GET /api/v1/services/s1/content-drift': noDrift,
      'POST /api/v1/services/s1/items/b/duplicate': reply(409, {
        error: { code: 'entity.state_conflict', message: 'conflict', requestId: 'r3', fields: [] },
      }),
    }, calls));
    render(<BulkBar view={view} />);

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));

    await screen.findByText('1 of 2 done. These were not changed:');
    expect(screen.getByText((content) => content.includes('Song B') && content.includes('This service changed or is locked. Reload to see the latest version.'))).toBeTruthy();
    expect(screen.queryByText('All 2 done.')).toBeNull();
    expect(calls).toEqual([
      'POST /api/v1/services/s1/items/a/duplicate',
      'GET /api/v1/services/s1/content-drift',
      'POST /api/v1/services/s1/items/b/duplicate',
    ]);
  });

  it('reports every item done when every step succeeds', async () => {
    setFetching(fakeFetch({
      'POST /api/v1/services/s1/items/a/enable': reply(200, successEnvelope(record([{ id: 'sec', name: 'Welcome', itemIds: ['a', 'b'] }]), 'r2')),
      'GET /api/v1/services/s1/content-drift': noDrift,
      'POST /api/v1/services/s1/items/b/enable': reply(200, successEnvelope(record([{ id: 'sec', name: 'Welcome', itemIds: ['a', 'b'] }]), 'r3')),
    }));
    render(<BulkBar view={view} />);

    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

    await screen.findByText('All 2 done.');
  });

  it('calls the disable endpoint for each selected item', async () => {
    const calls: string[] = [];
    setFetching(fakeFetch({
      'POST /api/v1/services/s1/items/a/disable': reply(200, successEnvelope(record([{ id: 'sec', name: 'Welcome', itemIds: ['a', 'b'] }]), 'r2')),
      'GET /api/v1/services/s1/content-drift': noDrift,
      'POST /api/v1/services/s1/items/b/disable': reply(200, successEnvelope(record([{ id: 'sec', name: 'Welcome', itemIds: ['a', 'b'] }]), 'r3')),
    }, calls));
    render(<BulkBar view={view} />);

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));

    await vi.waitFor(() => expect(calls).toEqual([
      'POST /api/v1/services/s1/items/a/disable',
      'GET /api/v1/services/s1/content-drift',
      'POST /api/v1/services/s1/items/b/disable',
      'GET /api/v1/services/s1/content-drift',
    ]));
  });

  it('calls the delete endpoint for each selected item on Remove', async () => {
    const calls: string[] = [];
    setFetching(fakeFetch({
      'DELETE /api/v1/services/s1/items/a': reply(200, successEnvelope(record([{ id: 'sec', name: 'Welcome', itemIds: ['b'] }]), 'r2')),
      'GET /api/v1/services/s1/content-drift': noDrift,
      'DELETE /api/v1/services/s1/items/b': reply(200, successEnvelope(record([{ id: 'sec', name: 'Welcome', itemIds: [] }]), 'r3')),
    }, calls));
    render(<BulkBar view={view} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await vi.waitFor(() => expect(calls).toEqual([
      'DELETE /api/v1/services/s1/items/a',
      'GET /api/v1/services/s1/content-drift',
      'DELETE /api/v1/services/s1/items/b',
      'GET /api/v1/services/s1/content-drift',
    ]));
  });

  it('picks a Move target once, then moves every selected item there in turn', async () => {
    const calls: string[] = [];
    setFetching(fakeFetch({
      'POST /api/v1/services/s1/sections/sec/items/reorder': reply(200, successEnvelope(record([{ id: 'sec', name: 'Welcome', itemIds: ['b', 'a'] }]), 'r2')),
      'GET /api/v1/services/s1/content-drift': noDrift,
    }, calls));
    render(<BulkBar view={view} />);

    fireEvent.click(screen.getByRole('button', { name: 'Move' }));
    const dialog = screen.getByRole('dialog', { name: 'Move To…' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Position' }), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));

    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]).toBe('POST /api/v1/services/s1/sections/sec/items/reorder');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  describe('keeps the selected items in their service order', () => {
    // A tiny server holding the order, so the result is what the requests actually produced.
    const serve = (start: Record<string, string[]>): { order: Record<string, string[]>; fetching: FetchLike } => {
      const order: Record<string, string[]> = structuredClone(start);
      const answer = () => reply(200, successEnvelope(record(Object.entries(order).map(([id, itemIds]) => ({ id, name: id, itemIds }))), 'r'));
      const fetching: FetchLike = async (url, init) => {
        if (url === '/api/v1/services/s1/content-drift') return noDrift;
        const body = init.body === undefined ? undefined : JSON.parse(init.body as string) as Record<string, unknown>;
        const reorder = /^\/api\/v1\/services\/s1\/sections\/([^/]+)\/items\/reorder$/u.exec(url);
        if (init.method === 'POST' && reorder?.[1] !== undefined) {
          order[reorder[1]] = body?.['itemIds'] as string[];
          return answer();
        }
        if (init.method === 'PATCH' && url === '/api/v1/services/s1') {
          for (const section of body?.['sections'] as { id: string; items: { id: string }[] }[]) {
            order[section.id] = section.items.map((item) => item.id);
          }
          return answer();
        }
        throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
      };
      return { order, fetching };
    };
    const viewOf = (order: Record<string, string[]>): ServiceView => ({
      ...view,
      sections: Object.entries(order).map(([id, itemIds]) => ({
        id, name: id, items: itemIds.map((itemId) => ({ id: itemId, kind: 'custom-slide' as const, title: itemId, enabled: true, content: undefined })),
      })),
    });
    const moveTo = async (section: string, position: string): Promise<void> => {
      fireEvent.click(screen.getByRole('button', { name: 'Move' }));
      const dialog = screen.getByRole('dialog', { name: 'Move To…' });
      fireEvent.change(within(dialog).getByRole('combobox', { name: 'Section' }), { target: { value: section } });
      fireEvent.change(within(dialog).getByRole('combobox', { name: 'Position' }), { target: { value: position } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
      await vi.waitFor(() => expect(screen.getByText('All 2 done.')).toBeTruthy());
    };

    it('across sections, in service order rather than click order', async () => {
      const start = { one: ['a', 'b', 'c', 'd', 'e'], two: ['x', 'y'] };
      const { order, fetching } = serve(start);
      setFetching(fetching);
      service.value = viewOf(start);
      select('b', 'e');
      render(<BulkBar view={viewOf(start)} />);

      await moveTo('two', '1');
      expect(order).toEqual({ one: ['a', 'c', 'd'], two: ['x', 'b', 'e', 'y'] });
    });

    it('within their own section, counting positions among the items that stay', async () => {
      const start = { one: ['a', 'b', 'c', 'd', 'e'] };
      const { order, fetching } = serve(start);
      setFetching(fetching);
      service.value = viewOf(start);
      select('b', 'a');
      render(<BulkBar view={viewOf(start)} />);

      fireEvent.click(screen.getByRole('button', { name: 'Move' }));
      const dialog = screen.getByRole('dialog', { name: 'Move To…' });
      expect(within(within(dialog).getByRole('combobox', { name: 'Position' })).getAllByRole('option')).toHaveLength(4);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      await moveTo('one', '3');
      expect(order).toEqual({ one: ['c', 'd', 'e', 'a', 'b'] });
    });
  });

  it('asks before leaving selection mode mid-run, and stays in selection mode if canceled', async () => {
    let resolveDuplicate: (value: ReturnType<typeof reply>) => void = () => {};
    setFetching(fakeFetch({
      'POST /api/v1/services/s1/items/a/duplicate': async () => new Promise((resolve) => { resolveDuplicate = resolve; }),
    }));
    const confirming = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirming);
    render(<BulkBar view={view} />);

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    await vi.waitFor(() => expect(bulkSelecting.value).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(confirming).toHaveBeenCalledWith('Stop selecting? The bulk action in progress will finish, but nothing else will be sent.');
    expect(bulkSelecting.value).toBe(true);

    confirming.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(bulkSelecting.value).toBe(false);

    await act(async () => {
      resolveDuplicate(reply(200, successEnvelope(record([{ id: 'sec', name: 'Welcome', itemIds: ['a', 'b'] }]), 'r2')));
    });
  });

  it('leaves selection mode without confirming when no run is in progress', () => {
    setFetching(fakeFetch({}));
    const confirming = vi.fn();
    vi.stubGlobal('confirm', confirming);
    render(<BulkBar view={view} />);

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(confirming).not.toHaveBeenCalled();
    expect(bulkSelecting.value).toBe(false);
    expect(bulkSelection.value.size).toBe(0);
  });
});
