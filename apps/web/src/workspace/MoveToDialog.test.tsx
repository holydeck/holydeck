// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import { successEnvelope } from '@holydeck/contracts/http';
import type { ServiceItem } from '@holydeck/contracts/services';
import type { SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';
import { session } from '../app-state.js';
import { setFetching } from '../request.js';
import { resetWorkspace, service } from '../state/workspace-store.js';
import { MoveToDialog } from './MoveToDialog.js';
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

const itemA: ServiceItem = { id: 'a', kind: 'custom-slide', title: 'a', enabled: true, content: undefined };
const itemB: ServiceItem = { id: 'b', kind: 'custom-slide', title: 'b', enabled: true, content: undefined };
const itemX: ServiceItem = { id: 'x', kind: 'custom-slide', title: 'x', enabled: true, content: undefined };
const itemY: ServiceItem = { id: 'y', kind: 'custom-slide', title: 'y', enabled: true, content: undefined };

const view: ServiceView = {
  id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', revision: 'r0',
  sections: [
    { id: 'sec', name: 'Welcome', items: [itemA, itemB] },
    { id: 'resp', name: 'Response', items: [itemX, itemY] },
  ],
};

const fakeFetch = (map: Record<string, ReturnType<typeof reply>>, calls: string[] = []): FetchLike =>
  async (url, init) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    calls.push(key);
    const response = map[key];
    if (response === undefined) throw new Error(`No reply for ${key}`);
    return response;
  };

beforeEach(() => {
  resetWorkspace();
  session.value = signedIn();
  service.value = view;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MoveToDialog', () => {
  it('opens focused on the section field, preselected to the item’s own section and position', () => {
    setFetching(fakeFetch({}));
    render(<MoveToDialog itemId="b" onClose={() => undefined} />);

    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Section' }));
    expect((screen.getByRole('combobox', { name: 'Section' }) as HTMLSelectElement).value).toBe('sec');
    expect((screen.getByRole('combobox', { name: 'Position' }) as HTMLSelectElement).value).toBe('1');
  });

  it('closes on Escape and on Cancel without sending any request', () => {
    setFetching(fakeFetch({}));
    const onClose = vi.fn();
    const { unmount } = render(<MoveToDialog itemId="b" onClose={onClose} />);

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Move To…' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    unmount();

    const onClose2 = vi.fn();
    render(<MoveToDialog itemId="b" onClose={onClose2} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose2).toHaveBeenCalledOnce();
  });

  it('moves the item into the chosen section and position with one PATCH, then closes', async () => {
    const calls: string[] = [];
    const fetching = fakeFetch({
      'PATCH /api/v1/services/s1': reply(200, successEnvelope(
        record([{ id: 'sec', name: 'Welcome', itemIds: ['a'] }, { id: 'resp', name: 'Response', itemIds: ['x', 'b', 'y'] }]), 'r2',
      )),
      'GET /api/v1/services/s1/content-drift': noDrift,
    }, calls);
    const bodies: unknown[] = [];
    setFetching(async (url, init) => {
      if ((init.method ?? 'GET') === 'PATCH') bodies.push(JSON.parse((init.body as string | undefined) ?? '{}'));
      return fetching(url, init);
    });
    const onClose = vi.fn();
    render(<MoveToDialog itemId="b" onClose={onClose} />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Section' }), { target: { value: 'resp' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Position' }), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    // A cross-section move is one PATCH carrying the whole post-move sections tree — never an
    // intermediate state with the item named in two sections, so its response always parses and one
    // content-drift refresh always follows it.
    expect(calls).toEqual([
      'PATCH /api/v1/services/s1',
      'GET /api/v1/services/s1/content-drift',
    ]);
    expect(bodies).toEqual([{
      title: 'Sunday', date: '2026-09-27', site: 'Main Hall',
      sections: [
        { id: 'sec', name: 'Welcome', items: [itemA] },
        { id: 'resp', name: 'Response', items: [itemX, itemB, itemY] },
      ],
    }]);
  });
});
