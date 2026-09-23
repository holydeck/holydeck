// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import { successEnvelope } from '@holydeck/contracts/http';
import type { SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';
import { session } from '../app-state.js';
import { setFetching } from '../request.js';
import { drift, resetWorkspace, service } from '../state/workspace-store.js';
import { DriftNotice } from './DriftNotice.js';
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

const record = (state: string) => ({
  stamp: {
    id: 's1', kind: 'service', schemaVersion: 1, createdAt: '2026-09-27T10:00:00.000Z', createdBy: 'account:andru',
    updatedAt: '2026-09-27T10:00:01.000Z', updatedBy: 'account:andru',
  },
  title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state, sections: [],
});

const view: ServiceView = {
  id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', revision: 'r0', sections: [],
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
  vi.unstubAllGlobals();
});

describe('DriftNotice', () => {
  it('shows nothing for an item with no drift entry', () => {
    drift.value = [];
    setFetching(fakeFetch({}));
    const { container } = render(<DriftNotice itemId="a" />);

    expect(container.textContent).toBe('');
  });

  it('shows the notice, and updates only on explicit click', async () => {
    drift.value = [{ itemId: 'a', latestRevision: 3 }];
    const calls: string[] = [];
    setFetching(fakeFetch({
      'POST /api/v1/services/s1/items/a/revise': reply(200, successEnvelope(record('upcoming'), 'r2')),
      'GET /api/v1/services/s1/content-drift': noDrift,
    }, calls));
    render(<DriftNotice itemId="a" />);

    expect(screen.getByText('A newer revision is available')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update to revision 3' })).toBeTruthy();
    expect(calls).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Update to revision 3' }));

    await vi.waitFor(() => expect(calls).toEqual([
      'POST /api/v1/services/s1/items/a/revise',
      'GET /api/v1/services/s1/content-drift',
    ]));
  });

  it('disables the update button while the workspace is read-only', () => {
    drift.value = [{ itemId: 'a', latestRevision: 3 }];
    service.value = { ...view, state: 'completed' };
    setFetching(fakeFetch({}));
    render(<DriftNotice itemId="a" />);

    expect(screen.getByRole('button', { name: 'Update to revision 3' }).hasAttribute('disabled')).toBe(true);
  });
});
