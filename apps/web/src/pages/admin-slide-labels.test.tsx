// @vitest-environment happy-dom
// The slide-label catalogue is administered here: list with usage counts, create, edit with a shortcut
// key and a collision warning, archive and restore. The confirm dialog asks the dependents route before
// an archive and shows its count when a label is in use.

import { render, screen, waitFor, fireEvent } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import type { SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';

import { App } from '../app.js';
import { resetAppState, session } from '../app-state.js';
import { setFetching } from '../request.js';
import { currentPath } from '../router.js';
import { SLIDE_LABELS_PATH, AdminSlideLabelsPage } from './admin-slide-labels.js';

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const signedIn = (permissions = ['catalogue.manage']): SessionView => ({
  account: { id: 'a1', name: 'andru', displayName: 'Andru Example', role: 'admin', controlPresentation: false },
  actor: 'account:a1',
  permissions,
  startedAt: '2026-09-13T09:30:00.000Z',
  lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z',
  rotation: 'authentication',
  csrf: 'c'.repeat(43),
  slots: [],
} as unknown as SessionView);

const stamp = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'label-1', kind: 'slideLabel', schemaVersion: 1,
  createdAt: '2026-09-01T00:00:00.000Z', createdBy: 'account:a1',
  updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'account:a1',
  archivedAt: undefined, archivedBy: undefined,
  ...overrides,
});

const label = (overrides: Partial<{ stamp: Record<string, unknown>; name: string; shortcut: string }> = {}) => ({
  name: 'Chorus', shortcut: '1',
  ...overrides,
  stamp: stamp(overrides.stamp),
});

const listReply = (entries: readonly unknown[]) => reply(200, successEnvelope(entries, 'request-labels'));

const renderPage = async (): Promise<void> => {
  currentPath.value = '/admin/slide-labels';
  // Keeps the shell's notification bell from polling and consuming a slot in this file's sequential
  // `mockResolvedValueOnce` fetch queues; the page under test never needs the bell to be active.
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
  render(<App />);
  await screen.findByRole('heading', { level: 1, name: 'Slide labels' });
};

describe('AdminSlideLabelsPage', () => {
  beforeEach(() => { resetAppState(); session.value = signedIn(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('renders the labels the server answers with', async () => {
    setFetching(async () => listReply([label()]));
    await renderPage();

    expect(await screen.findByText('Chorus')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('shows a label with no shortcut as such', async () => {
    setFetching(async () => listReply([label({ shortcut: undefined as unknown as string })]));
    await renderPage();

    expect(await screen.findByText('No shortcut')).toBeTruthy();
  });

  it('shows an archived label as archived, with a restore action', async () => {
    setFetching(async () => listReply([label({ stamp: { archivedAt: '2026-09-10T00:00:00.000Z', archivedBy: 'account:a1' } })]));
    await renderPage();

    expect(await screen.findByText('Archived')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restore Chorus' })).toBeTruthy();
  });

  it('archives a label after a confirmed dialog', async () => {
    const fetching = vi.fn<FetchLike>();
    fetching.mockResolvedValueOnce(listReply([label()]));
    fetching.mockResolvedValueOnce(reply(200, successEnvelope({ count: 0, approximate: true }, 'request-dependents')));
    fetching.mockResolvedValueOnce(reply(200, successEnvelope(label({ stamp: { archivedAt: '2026-09-11T00:00:00.000Z', archivedBy: 'account:a1' } }), 'request-status')));
    fetching.mockResolvedValueOnce(listReply([label({ stamp: { archivedAt: '2026-09-11T00:00:00.000Z', archivedBy: 'account:a1' } })]));
    setFetching(fetching);
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Archive Chorus' }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore Chorus' })).toBeTruthy());

    const [, dependentsCall, statusCall] = fetching.mock.calls;
    expect(dependentsCall?.[0]).toBe(`${SLIDE_LABELS_PATH}/label-1/dependents`);
    expect(statusCall?.[0]).toBe(`${SLIDE_LABELS_PATH}/label-1/status`);
    expect(statusCall?.[1]?.method).toBe('PATCH');
    expect(JSON.parse(statusCall?.[1]?.body ?? '{}')).toEqual({ archived: true });
  });

  it('closes the confirmation on Escape and hands focus back to the row action', async () => {
    const fetching = vi.fn<FetchLike>();
    fetching.mockResolvedValueOnce(listReply([label()]));
    fetching.mockResolvedValueOnce(reply(200, successEnvelope({ count: 0, approximate: false }, 'request-dependents')));
    setFetching(fetching);
    await renderPage();

    const action = screen.getByRole('button', { name: 'Archive Chorus' });
    action.focus();
    fireEvent.click(action);
    const dialog = await screen.findByRole('alertdialog');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(action);
  });

  it('restores an archived label with a fresh PATCH and reloads', async () => {
    const fetching = vi.fn<FetchLike>();
    fetching.mockResolvedValueOnce(listReply([label({ stamp: { archivedAt: '2026-09-10T00:00:00.000Z', archivedBy: 'account:a1' } })]));
    fetching.mockResolvedValueOnce(reply(200, successEnvelope(label(), 'request-status')));
    fetching.mockResolvedValueOnce(listReply([label()]));
    setFetching(fetching);
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Restore Chorus' }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Archive Chorus' })).toBeTruthy());

    const [, statusCall] = fetching.mock.calls;
    expect(statusCall?.[0]).toBe(`${SLIDE_LABELS_PATH}/label-1/status`);
    expect(JSON.parse(statusCall?.[1]?.body ?? '{}')).toEqual({ archived: false });
  });

  it('announces a refusal and keeps the prior state', async () => {
    const fetching = vi.fn<FetchLike>();
    fetching.mockResolvedValueOnce(listReply([label()]));
    fetching.mockResolvedValueOnce(reply(200, successEnvelope({ count: 0, approximate: true }, 'request-dependents')));
    fetching.mockResolvedValueOnce(reply(422, errorEnvelope('request.validation_failed', 'Refused', 'request-status', [
      { path: 'body.archived', code: 'entity.conflict', message: 'This label was already archived.' },
    ])));
    setFetching(fetching);
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Archive Chorus' }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect((await screen.findByRole('alert')).textContent).toBe('The change was refused: This label was already archived.');
  });

  it('shows a load failure as an alert', async () => {
    setFetching(async () => reply(500, errorEnvelope('server.failed', 'Failed', 'request-labels')));
    render(<AdminSlideLabelsPage />);

    expect((await screen.findByRole('alert')).textContent).toBe('The slide labels could not be loaded.');
  });

  it('renders not found and makes no request without catalogue.manage permission', () => {
    const fetching = vi.fn<FetchLike>();
    setFetching(fetching);
    session.value = signedIn([]);
    render(<AdminSlideLabelsPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(fetching).not.toHaveBeenCalled();
  });
});

describe('AdminSlideLabelsPage create and edit (COLAB-13)', () => {
  beforeEach(() => { resetAppState(); session.value = signedIn(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const verse = () => label({ stamp: { id: 'label-2' }, name: 'Verse', shortcut: '2' });

  it('shows how many slides use each label', async () => {
    setFetching(async () => listReply([{ ...label(), usage: 4 }]));
    await renderPage();

    expect(await screen.findByRole('columnheader', { name: 'Usage' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: '4' })).toBeTruthy();
  });

  it('adds a label with a shortcut key and reloads the list', async () => {
    const bridge = label({ stamp: { id: 'label-3' }, name: 'Bridge', shortcut: '3' });
    const fetching = vi.fn<FetchLike>();
    fetching.mockResolvedValueOnce(listReply([label()]));
    fetching.mockResolvedValueOnce(reply(201, successEnvelope(bridge, 'request-create')));
    fetching.mockResolvedValueOnce(listReply([label(), bridge]));
    setFetching(fetching);
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Add label' }));
    expect(screen.getByRole('heading', { level: 2, name: 'New label' })).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Bridge' } });
    fireEvent.change(screen.getByLabelText('Shortcut key'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Bridge')).toBeTruthy();
    const [, createCall] = fetching.mock.calls;
    expect(createCall?.[0]).toBe(SLIDE_LABELS_PATH);
    expect(createCall?.[1]?.method).toBe('POST');
    expect(JSON.parse(createCall?.[1]?.body ?? '{}')).toEqual({ name: 'Bridge', shortcut: '3' });
  });

  it('sends no shortcut when none is chosen', async () => {
    const fetching = vi.fn<FetchLike>();
    fetching.mockResolvedValueOnce(listReply([]));
    fetching.mockResolvedValueOnce(reply(201, successEnvelope(label({ name: 'Tag', shortcut: undefined as unknown as string }), 'request-create')));
    fetching.mockResolvedValueOnce(listReply([]));
    setFetching(fetching);
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Add label' }));
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Tag' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetching.mock.calls).toHaveLength(3));
    expect(JSON.parse(fetching.mock.calls[1]?.[1]?.body ?? '{}')).toEqual({ name: 'Tag' });
  });

  it('warns while a chosen key or name is already held by another live label', async () => {
    setFetching(async () => listReply([label(), verse()]));
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Verse' }));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Verse');
    expect((screen.getByLabelText('Shortcut key') as HTMLSelectElement).value).toBe('2');
    expect(screen.queryByText(/already/)).toBeNull();

    fireEvent.change(screen.getByLabelText('Shortcut key'), { target: { value: '1' } });
    expect(screen.getByText('Key 1 is already held by Chorus.')).toBeTruthy();
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Chorus' } });
    expect(screen.getByText('Another label is already called Chorus.')).toBeTruthy();
  });

  it('does not warn about a key held only by an archived label', async () => {
    setFetching(async () => listReply([label({ stamp: { archivedAt: '2026-09-10T00:00:00.000Z', archivedBy: 'account:a1' } })]));
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Add label' }));
    fireEvent.change(screen.getByLabelText('Shortcut key'), { target: { value: '1' } });

    expect(screen.queryByText(/already held/)).toBeNull();
  });

  it('edits a label and shows a server collision beside the shortcut field', async () => {
    const fetching = vi.fn<FetchLike>();
    fetching.mockResolvedValueOnce(listReply([label(), verse()]));
    fetching.mockResolvedValueOnce(reply(409, errorEnvelope('entity.conflict', 'Refused', 'request-edit', [
      { path: 'shortcut', code: 'field.not_allowed', message: 'the shortcut 1 is already held by label-1' },
    ])));
    setFetching(fetching);
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Verse' }));
    fireEvent.change(screen.getByLabelText('Shortcut key'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('the shortcut 1 is already held by label-1')).toBeTruthy();
    expect(screen.getByLabelText('Shortcut key').getAttribute('aria-invalid')).toBe('true');
    const [, editCall] = fetching.mock.calls;
    expect(editCall?.[0]).toBe(`${SLIDE_LABELS_PATH}/label-2`);
    expect(editCall?.[1]?.method).toBe('PUT');
    expect(JSON.parse(editCall?.[1]?.body ?? '{}')).toEqual({ name: 'Verse', shortcut: '1' });
  });
});
