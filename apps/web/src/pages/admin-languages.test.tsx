// @vitest-environment happy-dom
// The content-language catalogue is administered here, list plus archive/restore only (creating and
// editing a language is out of this screen's scope). Archiving is never refused for being in use
// (content-language-routes.ts), so the confirm dialog shows how many items currently use a language as
// information, not as a gate.

import { render, screen, waitFor, fireEvent } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import type { SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';

import { App } from '../app.js';
import { resetAppState, session } from '../app-state.js';
import { setFetching } from '../request.js';
import { currentPath } from '../router.js';
import { LANGUAGES_PATH, AdminLanguagesPage } from './admin-languages.js';

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
  id: 'ta', kind: 'contentLanguage', schemaVersion: 1,
  createdAt: '2026-09-01T00:00:00.000Z', createdBy: 'account:a1',
  updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'account:a1',
  archivedAt: undefined, archivedBy: undefined,
  ...overrides,
});

const language = (overrides: Partial<{ stamp: Record<string, unknown>; displayName: string; script: string; fallbackFont: string }> = {}) => ({
  displayName: 'Tamil', script: 'Tamil script', fallbackFont: 'Noto Sans Tamil',
  ...overrides,
  stamp: stamp(overrides.stamp),
});

const listReply = (entries: readonly unknown[]) => reply(200, successEnvelope(entries, 'request-languages'));

const renderPage = async (): Promise<void> => {
  currentPath.value = '/admin/languages';
  render(<App />);
  await screen.findByRole('heading', { level: 1, name: 'Content languages' });
};

describe('AdminLanguagesPage', () => {
  beforeEach(() => { resetAppState(); session.value = signedIn(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('renders the languages the server answers with', async () => {
    setFetching(async () => listReply([language()]));
    await renderPage();

    expect(await screen.findByText('Tamil')).toBeTruthy();
    expect(screen.getByText('Noto Sans Tamil')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('shows an archived language as archived, with a restore action', async () => {
    setFetching(async () => listReply([language({ stamp: { archivedAt: '2026-09-10T00:00:00.000Z', archivedBy: 'account:a1' } })]));
    await renderPage();

    expect(await screen.findByText('Archived')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restore Tamil' })).toBeTruthy();
  });

  it('archives a language after a confirmed dependents-aware dialog', async () => {
    const fetching = vi.fn<FetchLike>();
    fetching.mockResolvedValueOnce(listReply([language()]));
    fetching.mockResolvedValueOnce(reply(200, successEnvelope({ count: 3, approximate: true }, 'request-dependents')));
    fetching.mockResolvedValueOnce(reply(200, successEnvelope(language({ stamp: { archivedAt: '2026-09-11T00:00:00.000Z', archivedBy: 'account:a1' } }), 'request-status')));
    fetching.mockResolvedValueOnce(listReply([language({ stamp: { archivedAt: '2026-09-11T00:00:00.000Z', archivedBy: 'account:a1' } })]));
    setFetching(fetching);
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Archive Tamil' }));
    expect(await screen.findByText('3 items currently use this language.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore Tamil' })).toBeTruthy());

    const [, dependentsCall, statusCall] = fetching.mock.calls;
    expect(dependentsCall?.[0]).toBe(`${LANGUAGES_PATH}/ta/dependents`);
    expect(statusCall?.[0]).toBe(`${LANGUAGES_PATH}/ta/status`);
    expect(statusCall?.[1]?.method).toBe('PATCH');
    expect(JSON.parse(statusCall?.[1]?.body ?? '{}')).toEqual({ archived: true });
  });

  it('cancels an archive without sending the status change', async () => {
    const fetching = vi.fn<FetchLike>();
    fetching.mockResolvedValueOnce(listReply([language()]));
    fetching.mockResolvedValueOnce(reply(200, successEnvelope({ count: 0, approximate: true }, 'request-dependents')));
    setFetching(fetching);
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Archive Tamil' }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fetching.mock.calls).toHaveLength(2);
  });

  it('closes the confirmation on Escape and hands focus back to the row action', async () => {
    const fetching = vi.fn<FetchLike>();
    fetching.mockResolvedValueOnce(listReply([language()]));
    fetching.mockResolvedValueOnce(reply(200, successEnvelope({ count: 0, approximate: false }, 'request-dependents')));
    setFetching(fetching);
    await renderPage();

    const action = screen.getByRole('button', { name: 'Archive Tamil' });
    action.focus();
    fireEvent.click(action);
    const dialog = await screen.findByRole('alertdialog');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(action);
  });

  it('restores an archived language with a fresh PATCH and reloads', async () => {
    const fetching = vi.fn<FetchLike>();
    fetching.mockResolvedValueOnce(listReply([language({ stamp: { archivedAt: '2026-09-10T00:00:00.000Z', archivedBy: 'account:a1' } })]));
    fetching.mockResolvedValueOnce(reply(200, successEnvelope(language(), 'request-status')));
    fetching.mockResolvedValueOnce(listReply([language()]));
    setFetching(fetching);
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Restore Tamil' }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Archive Tamil' })).toBeTruthy());

    const [, statusCall] = fetching.mock.calls;
    expect(statusCall?.[0]).toBe(`${LANGUAGES_PATH}/ta/status`);
    expect(JSON.parse(statusCall?.[1]?.body ?? '{}')).toEqual({ archived: false });
  });

  it('announces a refusal and keeps the prior state', async () => {
    const fetching = vi.fn<FetchLike>();
    fetching.mockResolvedValueOnce(listReply([language()]));
    fetching.mockResolvedValueOnce(reply(200, successEnvelope({ count: 0, approximate: true }, 'request-dependents')));
    fetching.mockResolvedValueOnce(reply(422, errorEnvelope('request.validation_failed', 'Refused', 'request-status', [
      { path: 'body.archived', code: 'entity.conflict', message: 'This language was already archived.' },
    ])));
    setFetching(fetching);
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Archive Tamil' }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect((await screen.findByRole('alert')).textContent).toBe('The change was refused: This language was already archived.');
  });

  it('shows a load failure as an alert', async () => {
    setFetching(async () => reply(500, errorEnvelope('server.failed', 'Failed', 'request-languages')));
    render(<AdminLanguagesPage />);

    expect((await screen.findByRole('alert')).textContent).toBe('The content languages could not be loaded.');
  });

  it('renders not found and makes no request without catalogue.manage permission', () => {
    const fetching = vi.fn<FetchLike>();
    setFetching(fetching);
    session.value = signedIn([]);
    render(<AdminLanguagesPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(fetching).not.toHaveBeenCalled();
  });
});
