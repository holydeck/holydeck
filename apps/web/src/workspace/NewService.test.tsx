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

  const TEMPLATE = {
    id: 't1', name: 'Sunday order', createdAt: 'x', createdBy: 'y', revision: 1,
    body: {
      sections: [{
        id: 'sec', name: 'Welcome',
        entries: [
          { id: 'e1', slot: 'fixed', itemKind: 'song', title: 'Opening song', content: { id: 'c1', revision: 1 } },
          { id: 'e2', slot: 'typed', itemKind: 'custom-slide', required: true },
          { id: 'e3', slot: 'typed', itemKind: 'sermon', required: false },
          { id: 'bad', slot: 'typed', itemKind: 'unknown' },
          null,
        ],
      }, null],
    },
  };

  const fillEvent = (): void => {
    fireEvent.input(screen.getByLabelText('Date'), { target: { value: '2026-04-05' } });
    fireEvent.input(screen.getByLabelText('Title'), { target: { value: 'Easter' } });
    fireEvent.input(screen.getByLabelText('Site'), { target: { value: 'Main hall' } });
  };

  it('creates a service from a template, filling its custom-slide slot, and opens it', async () => {
    const calls: string[] = [];
    let sent: unknown;
    const base = fakeFetch({
      'GET /api/v1/services': reply(200, successEnvelope([], 'r-list')),
      'GET /api/v1/service-templates': reply(200, successEnvelope([{ id: 't1', name: 'Sunday order' }, { id: 't2', name: 'Evening' }, { nope: 1 }], 'r-t')),
      'GET /api/v1/service-templates/t1': reply(200, successEnvelope(TEMPLATE, 'r-t1')),
      'GET /api/v1/service-templates/t2': reply(403, errorEnvelope('auth.forbidden', 'no', 'r-t2')),
      'POST /api/v1/service-templates/t1/instantiate': reply(201, successEnvelope(record('s7', 'Easter', '2026-04-05'), 'r-i')),
    }, calls);
    setFetching(async (url, init) => {
      if (init.method === 'POST') sent = JSON.parse(String(init.body));
      return base(url, init);
    });
    await renderAt();

    await waitFor(() => expect((screen.getByRole('radio', { name: 'Admin Template' }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('radio', { name: 'Admin Template' }));
    const picker = screen.getByLabelText('Template to use') as HTMLSelectElement;
    expect(picker.value).toBe('t1');
    expect(await screen.findByText('Welcome: Song “Opening song”')).toBeTruthy();
    expect(screen.getByText('Welcome: Sermon slot — choose its content in the workspace once the service exists.')).toBeTruthy();

    fireEvent.change(picker, { target: { value: 't2' } });
    expect(await screen.findByText('This template’s entries are added as the service is created.')).toBeTruthy();
    fireEvent.change(picker, { target: { value: 't1' } });
    const slot = await screen.findByLabelText('Welcome: title for the Custom Slide slot (required)');
    fireEvent.input(slot, { target: { value: '  Announcements ' } });
    fillEvent();
    fireEvent.submit(screen.getByRole('button', { name: 'Create Service' }).closest('form') as HTMLFormElement);

    await waitFor(() => expect(currentPath.value).toBe('/services/s7'));
    expect(sent).toEqual({ title: 'Easter', date: '2026-04-05', site: 'Main hall', fills: [{ entryId: 'e2', title: 'Announcements' }] });
  });

  it('puts a refusal the server names for one entry beside that entry', async () => {
    setFetching(fakeFetch({
      'GET /api/v1/services': reply(200, successEnvelope([], 'r-list')),
      'GET /api/v1/service-templates': reply(200, successEnvelope([{ id: 't1', name: 'Sunday order' }], 'r-t')),
      'GET /api/v1/service-templates/t1': reply(200, successEnvelope(TEMPLATE, 'r-t1')),
      'POST /api/v1/service-templates/t1/instantiate': reply(422, errorEnvelope('request.validation_failed', 'no', 'r-i', [
        { path: 'fills.e3', code: 'field.required', message: 'e3 must be filled with pinned content' },
      ])),
    }));
    await renderAt();

    await waitFor(() => expect((screen.getByRole('radio', { name: 'Admin Template' }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('radio', { name: 'Admin Template' }));
    await screen.findByLabelText('Welcome: title for the Custom Slide slot (required)');
    fillEvent();
    fireEvent.submit(screen.getByRole('button', { name: 'Create Service' }).closest('form') as HTMLFormElement);

    expect(await screen.findByText('e3 must be filled with pinned content')).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.id).toBe('service-new-fill-e3'));
    expect(currentPath.value).toBe('/services/new');
  });

  it('asks for the title and site on the template path too', async () => {
    setFetching(fakeFetch({
      'GET /api/v1/services': reply(200, successEnvelope([], 'r-list')),
      'GET /api/v1/service-templates': reply(200, successEnvelope([{ id: 't1', name: 'Sunday order' }], 'r-t')),
      'GET /api/v1/service-templates/t1': reply(200, successEnvelope({ nope: true }, 'r-t1')),
    }));
    await renderAt();

    await waitFor(() => expect((screen.getByRole('radio', { name: 'Admin Template' }) as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('radio', { name: 'Admin Template' }));
    expect(await screen.findByText('This template’s entries are added as the service is created.')).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Date'), { target: { value: '2026-04-05' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create Service' }).closest('form') as HTMLFormElement);
    await waitFor(() => expect(document.activeElement?.id).toBe('service-new-title'));
  });

  it('disables Admin Template with an explanation when none are available', async () => {
    setFetching(fakeFetch({
      'GET /api/v1/services': reply(200, successEnvelope([], 'r-list')),
      'GET /api/v1/service-templates': reply(403, errorEnvelope('auth.forbidden', 'no', 'r-t')),
    }));
    await renderAt();

    expect(await screen.findByText('No templates are available to you.')).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'Admin Template' }) as HTMLInputElement).disabled).toBe(true);
  });
});
