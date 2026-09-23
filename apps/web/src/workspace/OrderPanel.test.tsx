// @vitest-environment happy-dom

import { fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import { successEnvelope } from '@holydeck/contracts/http';
import type { ServiceItem } from '@holydeck/contracts/services';
import type { SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';
import { session } from '../app-state.js';
import { setFetching } from '../request.js';
import { resetWorkspace, service } from '../state/workspace-store.js';
import { OrderPanel } from './OrderPanel.js';
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
const patchCallsOf = (fetching: ReturnType<typeof vi.fn<FetchLike>>) =>
  fetching.mock.calls.filter(([, init]) => (init as { method?: string }).method === 'PATCH');

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

const view: ServiceView = {
  id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', revision: 'r0',
  sections: [
    { id: 'sec', name: 'Welcome', items: [itemA] },
    { id: 'resp', name: 'Response', items: [] },
  ],
};

const emptyView: ServiceView = {
  ...view,
  sections: [{ id: 'sec', name: 'Welcome', items: [] }],
};

beforeEach(() => {
  resetWorkspace();
  session.value = signedIn();
  service.value = view;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('OrderPanel', () => {
  it('shows the empty state and calls onEmpty when Add Content is clicked', () => {
    service.value = emptyView;
    setFetching(async () => { throw new Error('no request expected'); });
    const onEmpty = vi.fn();
    render(<OrderPanel view={emptyView} onEmpty={onEmpty} />);

    expect(screen.getByText('This service has no items yet. Use the Library tab to add the first one.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add Content' }));
    expect(onEmpty).toHaveBeenCalledOnce();
  });

  it('renames a section with one PATCH request 800ms after the last keystroke', async () => {
    vi.useFakeTimers();
    const fetching = vi.fn<FetchLike>(async (url, init) => {
      if (init.method === 'PATCH' && url === '/api/v1/services/s1') {
        return reply(200, successEnvelope(record([{ id: 'sec', name: 'Praise', itemIds: ['a'] }, { id: 'resp', name: 'Response', itemIds: [] }]), 'r2'));
      }
      if (url === '/api/v1/services/s1/content-drift') return noDrift;
      throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
    });
    setFetching(fetching);
    render(<OrderPanel view={view} onEmpty={() => undefined} />);

    const welcomeSection = screen.getByText('Welcome').closest('.order-section') as HTMLElement;
    fireEvent.click(within(welcomeSection).getByRole('button', { name: 'Rename section' }));
    const input = screen.getByLabelText('Rename section');
    fireEvent.input(input, { target: { value: 'Praise' } });

    await vi.advanceTimersByTimeAsync(799);
    expect(fetching).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const patchCalls = patchCallsOf(fetching);
    expect(patchCalls).toHaveLength(1);
    const [, init] = patchCalls[0] ?? [];
    const body = JSON.parse((init as { body?: string })?.body ?? '{}') as { sections: { id: string; name: string }[] };
    expect(body.sections[0]?.name).toBe('Praise');
  });

  it('adds a new section with one PATCH request', async () => {
    const fetching = vi.fn<FetchLike>(async (url, init) => {
      if (init.method === 'PATCH' && url === '/api/v1/services/s1') {
        return reply(200, successEnvelope(record([
          { id: 'sec', name: 'Welcome', itemIds: ['a'] }, { id: 'resp', name: 'Response', itemIds: [] }, { id: 'new-1', name: 'New Section', itemIds: [] },
        ]), 'r2'));
      }
      if (url === '/api/v1/services/s1/content-drift') return noDrift;
      throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
    });
    setFetching(fetching);
    render(<OrderPanel view={view} onEmpty={() => undefined} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add Section' }));

    await vi.waitFor(() => expect(patchCallsOf(fetching)).toHaveLength(1));
    const [, init] = patchCallsOf(fetching)[0] ?? [];
    const body = JSON.parse((init as { body?: string })?.body ?? '{}') as { sections: { name: string }[] };
    expect(body.sections).toHaveLength(3);
    expect(body.sections[2]?.name).toBe('New Section');
  });

  it('removes an empty section without sending a request for one that still holds items', async () => {
    const fetching = vi.fn<FetchLike>(async (url, init) => {
      if (init.method === 'PATCH' && url === '/api/v1/services/s1') {
        return reply(200, successEnvelope(record([{ id: 'sec', name: 'Welcome', itemIds: ['a'] }]), 'r2'));
      }
      if (url === '/api/v1/services/s1/content-drift') return noDrift;
      throw new Error(`unexpected ${init.method ?? 'GET'} ${url}`);
    });
    setFetching(fetching);
    render(<OrderPanel view={view} onEmpty={() => undefined} />);

    const welcomeSection = screen.getByText('Welcome').closest('.order-section') as HTMLElement;
    const responseSection = screen.getByText('Response').closest('.order-section') as HTMLElement;
    fireEvent.click(within(welcomeSection).getByRole('button', { name: 'Remove Section' }));
    expect(screen.getByRole('alert').textContent).toBe('This section still has items. Move or remove them first.');
    expect(fetching).not.toHaveBeenCalled();

    fireEvent.click(within(responseSection).getByRole('button', { name: 'Remove Section' }));
    await vi.waitFor(() => expect(patchCallsOf(fetching)).toHaveLength(1));
  });
});
