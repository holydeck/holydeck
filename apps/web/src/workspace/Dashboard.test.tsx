// @vitest-environment happy-dom

import { fireEvent, render, screen, within } from '@testing-library/preact';
import { beforeEach, describe, expect, it } from 'vitest';

import { type AccountRecord } from '@holydeck/contracts/accounts';
import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import { type SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';
import type { ServiceView } from './service-data.js';

import { App } from '../app.js';
import { resetAppState, session } from '../app-state.js';
import { setFetching } from '../request.js';
import { currentPath } from '../router.js';
import { rememberAnswer } from './offline-cache.js';

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

const record = (id: string, title: string, date: string, state = 'upcoming') => ({
  stamp: {
    id, kind: 'service', schemaVersion: 1, createdAt: '2026-09-27T10:00:00.000Z', createdBy: 'account:andru',
    updatedAt: '2026-09-27T10:00:00.000Z', updatedBy: 'account:andru',
  },
  title, date, site: 'Main Hall', state, sections: [],
});

const view = (id: string, title: string, date: string): ServiceView => ({
  id, title, date, site: 'Main Hall', state: 'upcoming', sections: [], revision: '2026-09-27T10:00:00.000Z',
});

const noCurrent = reply(404, errorEnvelope('resource.not_found', 'none', 'r-current'));
const noPosition = reply(200, successEnvelope({ position: undefined }, 'r-position'));

const fakeFetch = (map: Record<string, ReturnType<typeof reply>>, calls: string[] = []): FetchLike =>
  async (url, init) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    calls.push(key);
    const response = map[key];
    if (response === undefined) throw new Error(`No reply for ${key}`);
    return response;
  };

const renderAt = async (): Promise<void> => {
  currentPath.value = '/services';
  render(<App />);
  await screen.findByRole('heading', { level: 1, name: 'Services' });
};

beforeEach(() => {
  resetAppState();
  session.value = signedIn();
});

describe('the services dashboard', () => {
  it('shows the next service first with Prepare as the only accent action', async () => {
    setFetching(fakeFetch({
      'GET /api/v1/services/current': noCurrent,
      'GET /api/v1/services': reply(200, successEnvelope([
        record('s1', 'Sunday', '2099-01-04'),
        record('s0', 'Last week', '2000-01-02'),
      ], 'r-list')),
      'GET /api/v1/me/workspace-position': noPosition,
    }));
    await renderAt();

    const next = await screen.findByRole('region', { name: 'Next service' });
    expect(within(next).getByRole('link', { name: 'Prepare Service' }).getAttribute('href')).toBe('/services/s1/readiness');
    expect(within(next).getByRole('link', { name: 'Present Service' }).getAttribute('href')).toBe('/services/s1/readiness?intent=present');
    expect(within(next).getByRole('link', { name: 'Edit Service' }).getAttribute('href')).toBe('/services/s1');
    expect(next.querySelectorAll('.accent')).toHaveLength(1);
  });

  it('shows the empty state when there is nothing upcoming', async () => {
    setFetching(fakeFetch({
      'GET /api/v1/services/current': noCurrent,
      'GET /api/v1/services': reply(200, successEnvelope([], 'r-list')),
      'GET /api/v1/me/workspace-position': noPosition,
    }));
    await renderAt();

    expect(await screen.findByText('No upcoming services')).toBeTruthy();
    expect(screen.getByText('Create a service to start building the order.')).toBeTruthy();
  });

  it('shows the load error with Try Again, which refetches', async () => {
    let listCalls = 0;
    setFetching(async (url, init) => {
      const key = `${init.method ?? 'GET'} ${url}`;
      if (key === 'GET /api/v1/services') {
        listCalls += 1;
        return listCalls === 1
          ? reply(500, errorEnvelope('server.failed', 'Failed', 'r-list'))
          : reply(200, successEnvelope([record('s1', 'Sunday', '2099-01-04')], 'r-list2'));
      }
      if (key === 'GET /api/v1/services/current') return noCurrent;
      if (key === 'GET /api/v1/me/workspace-position') return noPosition;
      throw new Error(`No reply for ${key}`);
    });
    await renderAt();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe("We couldn't load this workspace. Check your connection and try again.");

    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));

    await screen.findByRole('region', { name: 'Next service' });
    expect(listCalls).toBe(2);
  });

  it('shows the cached list labelled with its time when offline', async () => {
    rememberAnswer('services', [view('s1', 'Sunday', '2099-01-04')], new Date('2026-09-23T10:15:00.000Z'));
    setFetching(fakeFetch({
      'GET /api/v1/services/current': noCurrent,
      'GET /api/v1/services': reply(500, errorEnvelope('client.network_unreachable', 'offline', 'r-list')),
      'GET /api/v1/me/workspace-position': noPosition,
    }));
    await renderAt();

    expect(await screen.findByText(/^Offline\. Showing the list from/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sunday' })).toBeTruthy();
  });

  it('hides archived services until Show archived is checked', async () => {
    setFetching(fakeFetch({
      'GET /api/v1/services/current': noCurrent,
      'GET /api/v1/services': reply(200, successEnvelope([
        record('s1', 'Sunday', '2099-01-04'),
        record('s2', 'Old Retreat', '2000-01-01', 'archived'),
      ], 'r-list')),
      'GET /api/v1/me/workspace-position': noPosition,
    }));
    await renderAt();

    await screen.findByRole('region', { name: 'Next service' });
    expect(screen.queryByText('Old Retreat')).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show archived' }));

    expect(await screen.findByText('Old Retreat')).toBeTruthy();
  });

  it('offers Continue where you left off, and the dropped-item notice', async () => {
    const envelope = successEnvelope({ position: { serviceId: 's1' } }, 'r-position');
    setFetching(fakeFetch({
      'GET /api/v1/services/current': noCurrent,
      'GET /api/v1/services': reply(200, successEnvelope([record('s1', 'Sunday', '2099-01-04')], 'r-list')),
      'GET /api/v1/me/workspace-position': reply(200, { ...envelope, meta: { ...envelope.meta, dropped: ['itemId'] } }),
    }));
    await renderAt();

    expect(await screen.findByRole('link', { name: 'Open Sunday' })).toBeTruthy();
    expect(screen.getByText('The item you were last viewing is no longer available.')).toBeTruthy();
  });
});
