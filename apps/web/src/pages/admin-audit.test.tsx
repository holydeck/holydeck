// @vitest-environment happy-dom
// The audit log is a read-only administrative view: these tests keep its filters, entries and paging
// tied to the trail's real contract (audit-routes.ts) rather than to an implementation detail of the table.

import { render, screen, waitFor, fireEvent } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import type { SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';

import { App } from '../app.js';
import { resetAppState, session } from '../app-state.js';
import { setFetching } from '../request.js';
import { currentPath } from '../router.js';
import { AUDIT_PATH, AdminAuditPage } from './admin-audit.js';

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const signedIn = (permissions = ['audit.read']): SessionView => ({
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

const entry = (overrides: Partial<{
  id: string;
  at: string;
  category: string;
  action: string;
  actor: string;
  subject: string;
  outcome: string;
  detail: string;
}> = {}) => ({
  id: 'audit-1',
  at: '2026-09-22T00:00:00.000Z',
  category: 'authentication',
  action: 'session.signIn',
  actor: 'account:a1',
  subject: 'service:s1',
  outcome: 'allowed',
  ...overrides,
});

const pageReply = (entries: readonly unknown[], nextCursor?: { at: string; id: string }) =>
  reply(200, successEnvelope({ entries, ...(nextCursor === undefined ? {} : { nextCursor }) }, 'request-audit'));

const renderPage = async (): Promise<void> => {
  currentPath.value = '/admin/audit';
  render(<App />);
  await screen.findByRole('heading', { level: 1, name: 'Audit log' });
};

describe('AdminAuditPage', () => {
  beforeEach(() => {
    resetAppState();
    session.value = signedIn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the entries the server answers with', async () => {
    setFetching(async () => pageReply([entry()]));
    await renderPage();

    expect(await screen.findByText('session.signIn')).toBeTruthy();
    expect(screen.getByText('account:a1')).toBeTruthy();
    expect(screen.getByText('service:s1')).toBeTruthy();
  });

  it('filters by category with a fresh request', async () => {
    const fetching = vi.fn<FetchLike>(async () => pageReply([]));
    setFetching(fetching);
    await renderPage();

    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'settings' } });
    await waitFor(() => expect(fetching.mock.calls.at(-1)?.[0]).toBe(`${AUDIT_PATH}?category=settings`));
  });

  it('filters by outcome with a fresh request', async () => {
    const fetching = vi.fn<FetchLike>(async () => pageReply([]));
    setFetching(fetching);
    await renderPage();

    fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'refused' } });
    await waitFor(() => expect(fetching.mock.calls.at(-1)?.[0]).toBe(`${AUDIT_PATH}?outcome=refused`));
  });

  it('shows each entry’s detail in its own column', async () => {
    setFetching(async () => pageReply([entry({ detail: 'changed locale, port' })]));
    await renderPage();

    expect(await screen.findByRole('columnheader', { name: 'Detail' })).toBeTruthy();
    expect(screen.getByText('changed locale, port')).toBeTruthy();
  });

  it('narrows by a from and a to date with a fresh request', async () => {
    const fetching = vi.fn<FetchLike>(async () => pageReply([]));
    setFetching(fetching);
    await renderPage();

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } });
    await waitFor(() => expect(fetching.mock.calls.at(-1)?.[0]).toBe(`${AUDIT_PATH}?from=2026-09-01`));
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-30' } });
    await waitFor(() => expect(fetching.mock.calls.at(-1)?.[0]).toBe(`${AUDIT_PATH}?from=2026-09-01&to=2026-09-30`));
  });

  it('exports every page of the current filter as CSV, made in the browser from what the server answered', async () => {
    const fetching = vi.fn<FetchLike>(async (path) => {
      if (path.includes('cursorId=audit-1')) {
        return pageReply([entry({ id: 'audit-2', action: 'session.lock', detail: '=HYPERLINK("x")' })]);
      }
      return pageReply([entry({ detail: 'said "hello", twice' })], { at: '2026-09-22T00:00:00.000Z', id: 'audit-1' });
    });
    setFetching(fetching);
    const kept: Blob[] = [];
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', class extends URL {
      static override createObjectURL = vi.fn((blob: Blob) => {
        kept.push(blob);
        return 'blob:audit';
      });
      static override revokeObjectURL = revokeObjectURL;
    });
    await renderPage();
    fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'allowed' } });
    await waitFor(() => expect(fetching.mock.calls.at(-1)?.[0]).toBe(`${AUDIT_PATH}?outcome=allowed`));

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    await waitFor(() => expect(kept).toHaveLength(1));
    expect(fetching.mock.calls.slice(-2).map(([path]) => path)).toEqual([
      `${AUDIT_PATH}?outcome=allowed&limit=100`,
      `${AUDIT_PATH}?outcome=allowed&cursorAt=2026-09-22T00%3A00%3A00.000Z&cursorId=audit-1&limit=100`,
    ]);
    expect(await kept[0]?.text()).toBe([
      'at,category,action,actor,subject,outcome,detail',
      '2026-09-22T00:00:00.000Z,authentication,session.signIn,account:a1,service:s1,allowed,"said ""hello"", twice"',
      '2026-09-22T00:00:00.000Z,authentication,session.lock,account:a1,service:s1,allowed,"\'=HYPERLINK(""x"")"',
      '',
    ].join('\r\n'));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:audit');
    vi.unstubAllGlobals();
  });

  it('says so when the export cannot be read, and makes no file', async () => {
    setFetching(async (path) => path.includes('limit=100')
      ? reply(500, errorEnvelope('server.failed', 'Failed', 'request-audit'))
      : pageReply([entry()]));
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    expect((await screen.findByRole('alert')).textContent).toBe('The audit log could not be exported.');
  });

  it('loads another page from the cursor the server named', async () => {
    const fetching = vi.fn<FetchLike>();
    fetching.mockResolvedValueOnce(pageReply([entry()], { at: '2026-09-22T00:00:00.000Z', id: 'audit-1' }));
    fetching.mockResolvedValueOnce(pageReply([entry({ id: 'audit-2', action: 'session.lock' })]));
    setFetching(fetching);
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByText('session.lock')).toBeTruthy());
    expect(screen.getByText('session.signIn')).toBeTruthy();
    expect(fetching.mock.calls[1]?.[0]).toBe(`${AUDIT_PATH}?cursorAt=2026-09-22T00%3A00%3A00.000Z&cursorId=audit-1`);
  });

  it('shows a load failure as an alert', async () => {
    setFetching(async () => reply(500, errorEnvelope('server.failed', 'Failed', 'request-audit')));
    render(<AdminAuditPage />);

    expect((await screen.findByRole('alert')).textContent).toBe('The audit log could not be loaded.');
  });

  it('renders not found and makes no request without audit.read permission', () => {
    const fetching = vi.fn<FetchLike>();
    setFetching(fetching);
    session.value = signedIn([]);
    render(<AdminAuditPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(fetching).not.toHaveBeenCalled();
  });
});
