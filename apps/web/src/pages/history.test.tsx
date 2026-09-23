// @vitest-environment happy-dom
// The content history screen: the parsed revision list, a two-revision compare with its diff, and a
// restore gated behind an explicit confirm step, mirroring admin-users.tsx's own conventions.

import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import { CSRF_HEADER, type SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';

import { resetAppState, session } from '../app-state.js';
import { setFetching } from '../request.js';
import { HistoryPage } from './history.js';

const csrf = 'c'.repeat(43);
const contentId = 'song:1';
const path = `/api/v1/content/${encodeURIComponent(contentId)}/revisions`;

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const record = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  contentId,
  revision: 1,
  hash: `sha256-${'a'.repeat(64)}`,
  origin: 'autosave',
  at: '2026-09-22T01:00:00.000Z',
  actor: 'account:1',
  correlationId: 'req-1',
  body: { title: 'Song' },
  ...overrides,
});

const signedIn = (permissions: readonly string[] = ['contentHistory.manage']): SessionView => ({
  account: {
    id: 'GLkQ5wEtQEy5PfN2Zr9m7A',
    name: 'andru',
    displayName: 'Andru Example',
    role: 'admin',
    controlPresentation: true,
  },
  actor: 'account:GLkQ5wEtQEy5PfN2Zr9m7A',
  permissions,
  startedAt: '2026-09-13T09:30:00.000Z',
  lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z',
  rotation: 'authentication',
  csrf,
  slots: [],
});

describe('HistoryPage', () => {
  beforeEach(() => {
    resetAppState();
    session.value = signedIn();
  });

  it('renders the parsed revision list, most recent first', async () => {
    const two = record({ revision: 2, at: '2026-09-22T02:00:00.000Z', origin: 'manual-checkpoint' });
    const one = record({ revision: 1 });
    setFetching(async () => reply(200, successEnvelope([two, one], 'request-list')));

    render(<HistoryPage contentId={contentId} />);

    expect(await screen.findByText('Revision 2 — 2026-09-22T02:00:00.000Z')).toBeTruthy();
    expect(screen.getByText('Revision 1 — 2026-09-22T01:00:00.000Z')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Restore' })).toHaveLength(2);
  });

  it('drops a revision row that fails to parse while keeping the valid ones', async () => {
    const bad = record({ revision: 3, origin: 'not-a-real-origin' });
    const good = record({ revision: 1 });
    setFetching(async () => reply(200, successEnvelope([bad, good], 'request-list')));

    render(<HistoryPage contentId={contentId} />);

    expect(await screen.findByText('Revision 1 — 2026-09-22T01:00:00.000Z')).toBeTruthy();
    expect(screen.queryByText(/Revision 3/u)).toBeNull();
  });

  it('compares two selected revisions and shows their diff', async () => {
    const two = record({ revision: 2 });
    const one = record({ revision: 1 });
    const fetching = vi.fn<FetchLike>(async (requestPath) => requestPath.includes('/compare')
      ? reply(200, successEnvelope({
        from: one,
        to: two,
        diff: [{ path: 'body.title', kind: 'changed', before: 'Old title', after: 'New title' }],
      }, 'request-compare'))
      : reply(200, successEnvelope([two, one], 'request-list')));
    setFetching(fetching);

    render(<HistoryPage contentId={contentId} />);
    const checkboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(checkboxes[0] as HTMLInputElement);
    fireEvent.click(checkboxes[1] as HTMLInputElement);
    fireEvent.click(screen.getByRole('button', { name: 'Compare selected' }));

    expect(await screen.findByText(/body\.title/u)).toBeTruthy();
    expect(screen.getByText(/changed/u)).toBeTruthy();
    expect(fetching.mock.calls.some(([calledPath]) => calledPath === `${path}/compare?from=1&to=2`)).toBe(true);
  });

  it('shows a compare refusal as an alert', async () => {
    const two = record({ revision: 2 });
    const one = record({ revision: 1 });
    const fetching = vi.fn<FetchLike>(async (requestPath) => requestPath.includes('/compare')
      ? reply(500, errorEnvelope('server.failed', 'Failed', 'request-compare'))
      : reply(200, successEnvelope([two, one], 'request-list')));
    setFetching(fetching);

    render(<HistoryPage contentId={contentId} />);
    const checkboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(checkboxes[0] as HTMLInputElement);
    fireEvent.click(checkboxes[1] as HTMLInputElement);
    fireEvent.click(screen.getByRole('button', { name: 'Compare selected' }));

    expect((await screen.findByRole('alert')).textContent).toBeTruthy();
  });

  it('restores a revision after an explicit confirm step', async () => {
    const one = record({ revision: 1 });
    const restored = record({ revision: 2, at: '2026-09-23T00:00:00.000Z' });
    const lists = [[one], [restored, one]];
    const fetching = vi.fn<FetchLike>(async (_requestPath, init) => init.method === 'POST'
      ? reply(200, successEnvelope({ appended: true, revision: restored, from: 1 }, 'request-restore'))
      : reply(200, successEnvelope(lists.shift() ?? [], 'request-list')));
    setFetching(fetching);

    render(<HistoryPage contentId={contentId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    expect(await screen.findByRole('alertdialog')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(await screen.findByText('Revision 2 — 2026-09-23T00:00:00.000Z')).toBeTruthy();
    expect(fetching.mock.calls[1]?.[0]).toBe(`${path}/1/restore`);
    expect(fetching.mock.calls[1]?.[1].headers[CSRF_HEADER]).toBe(csrf);
  });

  it('cancels the restore confirmation without calling the server again', async () => {
    const fetching = vi.fn<FetchLike>(async () => reply(200, successEnvelope([record({ revision: 1 })], 'request-list')));
    setFetching(fetching);

    render(<HistoryPage contentId={contentId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fetching).toHaveBeenCalledTimes(1);
  });

  it('closes the restore confirmation on Escape and hands focus back to Restore', async () => {
    setFetching(vi.fn<FetchLike>(async () => reply(200, successEnvelope([record({ revision: 1 })], 'request-list'))));

    render(<HistoryPage contentId={contentId} />);
    const action = await screen.findByRole('button', { name: 'Restore' });
    action.focus();
    fireEvent.click(action);
    const dialog = await screen.findByRole('alertdialog');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(action);
  });

  it('shows a restore refusal as an alert', async () => {
    const fetching = vi.fn<FetchLike>(async (_requestPath, init) => init.method === 'POST'
      ? reply(422, errorEnvelope('request.validation_failed', 'Refused', 'request-restore', []))
      : reply(200, successEnvelope([record({ revision: 1 })], 'request-list')));
    setFetching(fetching);

    render(<HistoryPage contentId={contentId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect((await screen.findByRole('alert')).textContent).toBeTruthy();
  });

  it('reads the list again after a restore that appended nothing, so no revision shows twice', async () => {
    const one = record({ revision: 1 });
    const fetching = vi.fn<FetchLike>(async (_requestPath, init) => init.method === 'POST'
      ? reply(200, successEnvelope({ appended: false, revision: one, from: 1 }, 'request-restore'))
      : reply(200, successEnvelope([one], 'request-list')));
    setFetching(fetching);

    render(<HistoryPage contentId={contentId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(fetching.mock.calls).toHaveLength(3));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getAllByText(/^Revision 1 — /)).toHaveLength(1);
  });

  it('says so when the history cannot be loaded', async () => {
    setFetching(async () => reply(500, errorEnvelope('server.failed', 'Failed', 'request-list')));
    render(<HistoryPage contentId={contentId} />);

    expect((await screen.findByRole('alert')).textContent).toBe('The revision history could not be loaded.');
  });

  it('says so when the content has no history to show', async () => {
    setFetching(async () => reply(404, errorEnvelope('resource.not_found', 'Not found', 'request-list')));
    render(<HistoryPage contentId={contentId} />);

    expect((await screen.findByRole('alert')).textContent).toBe('No history was found for this content.');
  });

  it('renders not found and makes no request without content history permission', () => {
    const fetching = vi.fn<FetchLike>();
    setFetching(fetching);
    session.value = signedIn([]);

    render(<HistoryPage contentId={contentId} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(fetching).not.toHaveBeenCalled();
  });
});
