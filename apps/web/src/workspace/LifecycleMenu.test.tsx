// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import { successEnvelope } from '@holydeck/contracts/http';
import type { SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';
import { session } from '../app-state.js';
import { setFetching } from '../request.js';
import { currentPath } from '../router.js';
import { resetWorkspace, service } from '../state/workspace-store.js';
import { LifecycleMenu } from './LifecycleMenu.js';
import type { ServiceView } from './service-data.js';

const me: AccountRecord = {
  id: 'GLkQ5wEtQEy5PfN2Zr9m7A', name: 'andru', displayName: 'Andru Example', role: 'admin',
  createdAt: '2026-09-13T09:30:00.000Z', controlPresentation: true, disabled: false,
};
const csrf = 'c'.repeat(43);

const signedIn = (permissions: readonly string[] = ['services.manage']): SessionView => ({
  account: me, actor: `account:${me.id}`, permissions,
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

describe('LifecycleMenu', () => {
  it('offers only the next lifecycle step, and confirms before moving into Presenting', async () => {
    const calls: string[] = [];
    setFetching(fakeFetch({
      'PATCH /api/v1/services/s1/transition': reply(200, successEnvelope(record('presenting'), 'r2')),
      'GET /api/v1/services/s1/content-drift': noDrift,
    }, calls));
    const confirming = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirming);
    render(<LifecycleMenu view={view} />);

    fireEvent.click(screen.getByRole('button', { name: 'Service' }));
    expect(screen.getByRole('menuitem', { name: 'Move to Presenting' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Move to Completed' })).toBeNull();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Presenting' }));

    expect(confirming).toHaveBeenCalledWith("Move this service to Presenting? This can't be undone.");
    await vi.waitFor(() => expect(calls).toEqual([
      'PATCH /api/v1/services/s1/transition',
      'GET /api/v1/services/s1/content-drift',
    ]));
  });

  it('does not move when the confirm is canceled', () => {
    const calls: string[] = [];
    setFetching(fakeFetch({}, calls));
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(false));
    render(<LifecycleMenu view={view} />);

    fireEvent.click(screen.getByRole('button', { name: 'Service' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Presenting' }));

    expect(calls).toEqual([]);
  });

  it('offers no Move item once the service is archived', () => {
    const archived: ServiceView = { ...view, state: 'archived' };
    setFetching(fakeFetch({}));
    render(<LifecycleMenu view={archived} />);

    fireEvent.click(screen.getByRole('button', { name: 'Service' }));
    expect(screen.queryByRole('menuitem', { name: /^Move to/ })).toBeNull();
  });

  it('schedules a date only while upcoming', async () => {
    const calls: string[] = [];
    setFetching(fakeFetch({
      'PATCH /api/v1/services/s1/schedule': reply(200, successEnvelope(record('upcoming'), 'r2')),
      'GET /api/v1/services/s1/content-drift': noDrift,
    }, calls));
    render(<LifecycleMenu view={view} />);

    fireEvent.click(screen.getByRole('button', { name: 'Service' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Schedule…' }));
    fireEvent.input(screen.getByLabelText('Schedule…'), { target: { value: '2026-10-04' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Date' }));

    await vi.waitFor(() => expect(calls).toEqual([
      'PATCH /api/v1/services/s1/schedule',
      'GET /api/v1/services/s1/content-drift',
    ]));

    const presenting: ServiceView = { ...view, state: 'presenting' };
    render(<LifecycleMenu view={presenting} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Service' })[1] ?? screen.getByRole('button', { name: 'Service' }));
    expect(screen.queryByRole('menuitem', { name: 'Schedule…' })).toBeNull();
  });

  it('duplicates the service and navigates to the copy', async () => {
    setFetching(fakeFetch({
      'POST /api/v1/services/s1/duplicate': reply(201, successEnvelope(record('upcoming'), 'r-dup')),
    }));
    render(<LifecycleMenu view={view} />);

    fireEvent.click(screen.getByRole('button', { name: 'Service' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate Service' }));

    await vi.waitFor(() => expect(currentPath.value).toBe('/services/s1'));
  });

  it('archives only after confirming, and unarchives without confirming', async () => {
    const calls: string[] = [];
    const confirming = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirming);
    setFetching(fakeFetch({
      'PATCH /api/v1/services/s1/status': reply(200, successEnvelope(record('upcoming'), 'r2')),
      'GET /api/v1/services/s1/content-drift': noDrift,
    }, calls));
    render(<LifecycleMenu view={view} />);

    fireEvent.click(screen.getByRole('button', { name: 'Service' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive Service' }));
    expect(confirming).toHaveBeenCalledWith('Archive this service? It stays readable and can be restored.');
    expect(calls).toEqual([]);

    confirming.mockReturnValue(true);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive Service' }));
    await vi.waitFor(() => expect(calls).toEqual([
      'PATCH /api/v1/services/s1/status',
      'GET /api/v1/services/s1/content-drift',
    ]));

    const confirmedSoFar = confirming.mock.calls.length;
    const archived: ServiceView = { ...view, state: 'archived' };
    render(<LifecycleMenu view={archived} />);
    const openers = screen.getAllByRole('button', { name: 'Service' });
    fireEvent.click(openers[openers.length - 1] ?? openers[0]!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unarchive Service' }));
    expect(confirming).toHaveBeenCalledTimes(confirmedSoFar);
  });

  it('is hidden entirely without services.manage', () => {
    session.value = signedIn([]);
    setFetching(fakeFetch({}));
    render(<LifecycleMenu view={view} />);

    expect(screen.queryByRole('button', { name: 'Service' })).toBeNull();
  });
});
