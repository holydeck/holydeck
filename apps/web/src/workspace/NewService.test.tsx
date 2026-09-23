// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type AccountRecord } from '@holydeck/contracts/accounts';
import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import { type SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';

import { App } from '../app.js';
import { resetAppState, session } from '../app-state.js';
import { setFetching } from '../request.js';
import { currentPath } from '../router.js';

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

const fakeFetch = (map: Record<string, ReturnType<typeof reply>>, calls: string[] = []): FetchLike =>
  async (url, init) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    calls.push(key);
    const response = map[key];
    if (response === undefined) throw new Error(`No reply for ${key}`);
    return response;
  };

const renderAt = async (): Promise<void> => {
  currentPath.value = '/services/new';
  render(<App />);
  await screen.findByRole('heading', { level: 1, name: 'New Service' });
};

beforeEach(() => {
  resetAppState();
  localStorage.clear();
  sessionStorage.clear();
  session.value = signedIn();
});

describe('creating a service', () => {
  it('creates a blank service and opens it', async () => {
    const calls: string[] = [];
    setFetching(fakeFetch({
      'GET /api/v1/services': reply(200, successEnvelope([], 'r-list')),
      'POST /api/v1/services': reply(201, successEnvelope(record('s9', 'Easter', '2026-04-05'), 'r-create')),
    }, calls));
    await renderAt();

    fireEvent.input(screen.getByLabelText('Date'), { target: { value: '2026-04-05' } });
    fireEvent.input(screen.getByLabelText('Title'), { target: { value: 'Easter' } });
    fireEvent.input(screen.getByLabelText('Site'), { target: { value: 'Main hall' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create Service' }).closest('form') as HTMLFormElement);

    await waitFor(() => expect(currentPath.value).toBe('/services/s9'));
    expect(calls).toContain('POST /api/v1/services');
  });

  it('maps a 422 to its field and focuses it', async () => {
    setFetching(fakeFetch({
      'GET /api/v1/services': reply(200, successEnvelope([], 'r-list')),
      'POST /api/v1/services': reply(422, errorEnvelope('validation.failed', 'invalid', 'r', [
        { path: 'service.title', code: 'field.empty', message: 'Title is required.' },
      ])),
    }));
    await renderAt();

    fireEvent.input(screen.getByLabelText('Date'), { target: { value: '2026-04-05' } });
    fireEvent.input(screen.getByLabelText('Title'), { target: { value: '!' } });
    fireEvent.input(screen.getByLabelText('Site'), { target: { value: 'Main hall' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create Service' }).closest('form') as HTMLFormElement);

    expect(await screen.findByText('Title is required.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Title')));
  });

  it('duplicates then schedules a previous service, in order', async () => {
    const calls: string[] = [];
    setFetching(fakeFetch({
      'GET /api/v1/services': reply(200, successEnvelope([record('s1', 'Sunday', '2026-01-04')], 'r-list')),
      'POST /api/v1/services/s1/duplicate': reply(201, successEnvelope(record('s-copy', 'Sunday', '2026-01-04'), 'r-dup')),
      'POST /api/v1/services/s-copy/schedule': reply(200, successEnvelope(record('s-copy', 'Sunday', '2026-01-11'), 'r-sched')),
    }, calls));
    await renderAt();

    await screen.findByRole('radio', { name: 'Previous Service' });
    fireEvent.click(screen.getByRole('radio', { name: 'Previous Service' }));
    fireEvent.submit(screen.getByRole('button', { name: 'Create Service' }).closest('form') as HTMLFormElement);

    await waitFor(() => expect(currentPath.value).toBe('/services/s-copy'));
    expect(calls.filter((call) => call.startsWith('POST'))).toEqual([
      'POST /api/v1/services/s1/duplicate',
      'POST /api/v1/services/s-copy/schedule',
    ]);
  });

  it('reports a copy that was made but not rescheduled', async () => {
    setFetching(fakeFetch({
      'GET /api/v1/services': reply(200, successEnvelope([record('s1', 'Sunday', '2026-01-04')], 'r-list')),
      'POST /api/v1/services/s1/duplicate': reply(201, successEnvelope(record('s-copy', 'Sunday', '2026-01-04'), 'r-dup')),
      'POST /api/v1/services/s-copy/schedule': reply(409, errorEnvelope('entity.state_conflict', 'locked', 'r-sched')),
    }));
    await renderAt();

    await screen.findByRole('radio', { name: 'Previous Service' });
    fireEvent.click(screen.getByRole('radio', { name: 'Previous Service' }));
    fireEvent.submit(screen.getByRole('button', { name: 'Create Service' }).closest('form') as HTMLFormElement);

    expect(await screen.findByText('The copy was made but not rescheduled. Open it to fix the date.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the service' }).getAttribute('href')).toBe('/services/s-copy');
  });

  it('disables Previous Service when there are none', async () => {
    setFetching(fakeFetch({
      'GET /api/v1/services': reply(200, successEnvelope([], 'r-list')),
    }));
    await renderAt();

    await screen.findByText('No previous services yet.');
    expect((screen.getByRole('radio', { name: 'Previous Service' }) as HTMLInputElement).disabled).toBe(true);
  });

  it('asks before discarding a dirty form', async () => {
    setFetching(fakeFetch({
      'GET /api/v1/services': reply(200, successEnvelope([], 'r-list')),
    }));
    await renderAt();

    fireEvent.input(screen.getByLabelText('Title'), { target: { value: 'Easter' } });

    const confirming = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirming);
    fireEvent.click(screen.getByRole('button', { name: 'Discard New Service' }));
    expect(currentPath.value).toBe('/services/new');

    confirming.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Discard New Service' }));
    expect(currentPath.value).toBe('/services');
    vi.unstubAllGlobals();
  });
});
